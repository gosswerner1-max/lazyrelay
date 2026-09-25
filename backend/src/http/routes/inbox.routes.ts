// inbox routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.

import { Router } from "express";
import { supabase } from "../../supabase.js";
import { type PlatformAdapterRegistry } from "../../platforms/connect.js";
import { requireAuth, requireHumanAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { triageItems, type TriageItem, type TriageResult } from "../../commentTriage.js";
import type { CommentItem } from "../../platforms/types.js";
import { dbError } from "./shared.js";

export function buildInboxRouter(registry: PlatformAdapterRegistry): Router {
  const router = Router();

  // Social listening, in the only honest sense currently buildable: reading
  // comments/replies on posts LazyRelay itself published (via each
  // adapter's optional getComments — see the PlatformAdapter comment for
  // why full keyword/brand-mention search across public content isn't in
  // scope here). Mastodon/Bluesky/YouTube/Facebook/Instagram implement it;
  // every other platform's posts come back with supported:false rather
  // than a silently empty comment list, so the UI never implies broader
  // coverage than actually exists.
  // Reads from mention_comments_cache (kept fresh by
  // mentionsAndDmsPoller.ts) rather than calling each platform live — see
  // migration 0058_mentions_dms_cache.sql. Post-level metadata
  // (content/scheduledFor/platformPostUrl) still comes straight from
  // scheduled_posts/post_results since the cache only stores comments.
  router.get("/mentions", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: posts, error } = await req.db!
      .from("scheduled_posts")
      .select("id, content, scheduled_for, social_account_id, social_accounts(platform), post_results(platform_post_id, platform_post_url, verified_live)")
      .eq("account_id", req.accountId)
      .eq("status", "posted")
      .order("scheduled_for", { ascending: false })
      .limit(15);
    if (error) {
      dbError(res, error, "GET /mentions");
      return;
    }

    const postIds = (posts ?? []).map((p) => p.id);
    // mention_comments_cache/dm_conversations_cache/notification_view_state
    // all stay on supabase throughout this file -- 0058_mentions_dms_cache.sql:
    // "No client-facing RLS policies... only the backend's service-role
    // client (the API routes and the poller) ever reads/writes these
    // tables."
    const { data: cachedComments, error: cacheError } = postIds.length
      ? await supabase
          .from("mention_comments_cache")
          .select("scheduled_post_id, platform_comment_id, author, text, url, comment_created_at")
          .in("scheduled_post_id", postIds)
          .order("comment_created_at", { ascending: true })
      : { data: [] as never[], error: null };
    if (cacheError) {
      dbError(res, cacheError, "GET /mentions cache lookup");
      return;
    }
    const commentsByPost = new Map<string, (CommentItem & { triage?: TriageResult | null })[]>();
    for (const c of cachedComments ?? []) {
      const list = commentsByPost.get(c.scheduled_post_id) ?? [];
      list.push({ id: c.platform_comment_id, author: c.author, text: c.text, url: c.url, createdAt: c.comment_created_at });
      commentsByPost.set(c.scheduled_post_id, list);
    }

    const results: {
      postId: string;
      socialAccountId: string;
      platform: string;
      content: string;
      scheduledFor: string;
      platformPostUrl: string | null;
      supported: boolean;
      canReply?: boolean;
      comments: (CommentItem & { triage?: TriageResult | null })[];
      errorMessage?: string | null;
    }[] = [];
    const commentTriageItems: TriageItem[] = [];
    for (const post of posts ?? []) {
      const platform = Array.isArray(post.social_accounts) ? post.social_accounts[0]?.platform : (post.social_accounts as { platform?: string } | null)?.platform;
      const results_ = Array.isArray(post.post_results) ? post.post_results : post.post_results ? [post.post_results] : [];
      const result = results_.find((r: { verified_live: boolean }) => r.verified_live);
      if (!platform || !result?.platform_post_id) continue;

      const adapter = registry.get(platform);
      const comments = commentsByPost.get(post.id) ?? [];
      results.push({
        postId: post.id,
        socialAccountId: post.social_account_id,
        platform,
        content: post.content,
        scheduledFor: post.scheduled_for,
        platformPostUrl: result.platform_post_url,
        supported: !!adapter?.getComments,
        canReply: !!adapter?.replyToComment,
        comments,
      });
      commentTriageItems.push(...comments.map((c) => ({ itemId: c.id, sourceSignature: c.id, author: c.author, text: c.text })));
    }

    // One batched Anthropic call for every not-yet-cached comment across
    // every post shown here, rather than one call per post — see
    // commentTriage.ts. Missing from the map means unclassified (no API
    // key configured, or the AI call failed), never treated as "routine".
    // In practice this is nearly always a cache hit now, since the poller
    // already ran triageItems() over these same comments when it cached
    // them.
    const triageMap = await triageItems(req.accountId!, "comment", commentTriageItems);
    for (const post of results) {
      post.comments = post.comments.map((c) => ({ ...c, triage: triageMap.get(c.id) ?? null }));
    }

    // Marks these as viewed AFTER the read that produced them, same
    // ordering dmAutomationPoller uses for its own side effects — a
    // comment that lands between this read and the next poll simply shows
    // up as new next time, not lost.
    // notification_view_state: service-role only, see the cache comment
    // above (0058_mentions_dms_cache.sql).
    await supabase
      .from("notification_view_state")
      .upsert({ account_id: req.accountId, mentions_last_viewed_at: new Date().toISOString() }, { onConflict: "account_id" });

    res.json({ posts: results });
  });

  // Reply to a comment surfaced by GET /mentions. postId is required (not
  // just commentId) so ownership can be checked the same way every other
  // account-scoped route does — a customer must own the post the comment
  // is attached to, never just supply an arbitrary commentId. Only
  // implemented for platforms whose adapter declares replyToComment
  // (Facebook, Instagram, Mastodon, Bluesky) — YouTube needs a new,
  // not-yet-requested scope (see PlatformAdapter's own comment).
  router.post("/mentions/reply", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { postId, commentId, text } = req.body as { postId?: string; commentId?: string; text?: string };
    if (!postId || !commentId || !text?.trim()) {
      res.status(400).json({ error: "postId, commentId, and text are all required" });
      return;
    }

    const { data: post, error: postError } = await req.db!
      .from("scheduled_posts")
      .select("account_id, social_account_id, social_accounts(platform)")
      .eq("id", postId)
      .maybeSingle();
    if (postError) {
      dbError(res, postError, "POST /mentions/reply");
      return;
    }
    if (!post || post.account_id !== req.accountId) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    const platform = Array.isArray(post.social_accounts) ? post.social_accounts[0]?.platform : (post.social_accounts as { platform?: string } | null)?.platform;
    const adapter = platform ? registry.get(platform) : undefined;
    if (!adapter?.replyToComment) {
      res.status(400).json({ error: `Replying isn't supported on ${platform ?? "this platform"} yet` });
      return;
    }

    const { data: account } = await req.db!
      .from("social_accounts")
      .select("access_token_vault_id")
      .eq("id", post.social_account_id)
      .single();
    // read_social_token: service_role-only grant, see the comment on GET
    // /social-accounts/:id/boards above (0003_fix_function_grants.sql).
    const { data: accessToken } = account
      ? await supabase.rpc("read_social_token", { p_vault_id: account.access_token_vault_id })
      : { data: null };
    if (!accessToken) {
      res.status(500).json({ error: "Could not load this account's access token" });
      return;
    }

    const result = await adapter.replyToComment(commentId, text.trim(), accessToken as string);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Reply failed" });
      return;
    }
    res.json({ success: true });
  });

  // DM inbox — priority (4) from the 2026-08-07 competitor audit. Only
  // Facebook and Instagram declare getConversations (new pages_messaging /
  // instagram_manage_messages permissions, added 2026-08-07 for exactly
  // this). Every other platform is silently skipped, not an error — this
  // list is additive across every DM-capable connected account, unlike
  // /mentions which is keyed off individual posts.
  // Reads from dm_conversations_cache (kept fresh by
  // mentionsAndDmsPoller.ts) rather than calling each connected account's
  // platform live — see migration 0058_mentions_dms_cache.sql.
  router.get("/dms", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: accounts, error } = await req.db!
      .from("social_accounts")
      .select("id, platform, display_name")
      .eq("account_id", req.accountId)
      .is("disconnected_at", null);
    if (error) {
      dbError(res, error, "GET /dms");
      return;
    }
    const accountById = new Map((accounts ?? []).map((a) => [a.id, a]));
    const socialAccountIds = (accounts ?? []).map((a) => a.id);

    // dm_conversations_cache: service-role only, see the cache comment on
    // GET /mentions above (0058_mentions_dms_cache.sql).
    const { data: cached, error: cacheError } = socialAccountIds.length
      ? await supabase
          .from("dm_conversations_cache")
          .select("social_account_id, conversation_id, participant_id, participant_name, snippet, conversation_updated_at")
          .in("social_account_id", socialAccountIds)
      : { data: [] as never[], error: null };
    if (cacheError) {
      dbError(res, cacheError, "GET /dms cache lookup");
      return;
    }

    const results: {
      socialAccountId: string;
      platform: string;
      accountDisplayName: string | null;
      conversationId: string;
      participantId: string;
      participantName: string;
      snippet: string | null;
      updatedAt: string | null;
      triage?: unknown;
    }[] = [];
    for (const c of cached ?? []) {
      const account = accountById.get(c.social_account_id);
      if (!account) continue; // stale row for a since-disconnected account
      results.push({
        socialAccountId: c.social_account_id,
        platform: account.platform,
        accountDisplayName: account.display_name,
        conversationId: c.conversation_id,
        participantId: c.participant_id,
        participantName: c.participant_name,
        snippet: c.snippet,
        updatedAt: c.conversation_updated_at,
      });
    }

    results.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

    // Classified off the conversation's latest-message snippet, not the full
    // thread — same "surface the one that needs a human" scope as /mentions.
    // sourceSignature is updatedAt, so a new incoming message naturally
    // invalidates the cached classification instead of the DM going stale.
    const dmTriageItems: TriageItem[] = results
      .filter((r) => !!r.snippet)
      .map((r) => ({ itemId: r.conversationId, sourceSignature: r.updatedAt ?? "", author: r.participantName, text: r.snippet! }));
    const triageMap = await triageItems(req.accountId!, "dm", dmTriageItems);
    for (const r of results) {
      r.triage = triageMap.get(r.conversationId) ?? null;
    }

    // notification_view_state: service-role only, see the cache comment on
    // GET /mentions above (0058_mentions_dms_cache.sql).
    await supabase
      .from("notification_view_state")
      .upsert({ account_id: req.accountId, dms_last_viewed_at: new Date().toISOString() }, { onConflict: "account_id" });

    res.json({ conversations: results });
  });

  // Powers the dashboard's notification bell — a cheap read of the two
  // cache tables (see migration 0058_mentions_dms_cache.sql), never a live
  // platform call. "New" means discovered/updated after the customer last
  // actually loaded that tab (notification_view_state, bumped by GET
  // /mentions and GET /dms themselves). Falls back to first_seen_at when a
  // platform doesn't supply its own timestamp (comment_created_at /
  // conversation_updated_at can both be null).
  router.get("/notifications/summary", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    // notification_view_state/mention_comments_cache/dm_conversations_cache:
    // service-role only throughout this route, see the cache comment on
    // GET /mentions above (0058_mentions_dms_cache.sql).
    const { data: viewState, error: viewStateError } = await supabase
      .from("notification_view_state")
      .select("mentions_last_viewed_at, dms_last_viewed_at")
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (viewStateError) {
      dbError(res, viewStateError, "GET /notifications/summary view state");
      return;
    }
    const mentionsSinceMs = new Date(viewState?.mentions_last_viewed_at ?? "1970-01-01T00:00:00Z").getTime();
    const dmsSinceMs = new Date(viewState?.dms_last_viewed_at ?? "1970-01-01T00:00:00Z").getTime();

    const [{ data: mentionRows, error: mentionsError }, { data: dmRows, error: dmsError }] = await Promise.all([
      supabase.from("mention_comments_cache").select("comment_created_at, first_seen_at").eq("account_id", req.accountId),
      supabase.from("dm_conversations_cache").select("conversation_updated_at, first_seen_at").eq("account_id", req.accountId),
    ]);
    if (mentionsError) {
      dbError(res, mentionsError, "GET /notifications/summary mentions");
      return;
    }
    if (dmsError) {
      dbError(res, dmsError, "GET /notifications/summary dms");
      return;
    }

    const newMentions = (mentionRows ?? []).filter(
      (r) => new Date(r.comment_created_at ?? r.first_seen_at).getTime() > mentionsSinceMs,
    ).length;
    const newDms = (dmRows ?? []).filter(
      (r) => new Date(r.conversation_updated_at ?? r.first_seen_at).getTime() > dmsSinceMs,
    ).length;

    res.json({ newMentions, newDms });
  });

  router.get("/dms/messages", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const socialAccountId = req.query.socialAccountId as string | undefined;
    const conversationId = req.query.conversationId as string | undefined;
    if (!socialAccountId || !conversationId) {
      res.status(400).json({ error: "socialAccountId and conversationId are required" });
      return;
    }

    const { data: account, error } = await req.db!
      .from("social_accounts")
      .select("account_id, platform, platform_account_id, access_token_vault_id")
      .eq("id", socialAccountId)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /dms/messages");
      return;
    }
    if (!account || account.account_id !== req.accountId) {
      res.status(404).json({ error: "Social account not found" });
      return;
    }

    const adapter = registry.get(account.platform);
    if (!adapter?.getDirectMessages) {
      res.status(400).json({ error: `DMs aren't supported on ${account.platform}` });
      return;
    }

    // read_social_token: service_role-only grant, see the comment on GET
    // /social-accounts/:id/boards above (0003_fix_function_grants.sql).
    const { data: accessToken } = await supabase.rpc("read_social_token", { p_vault_id: account.access_token_vault_id });
    if (!accessToken) {
      res.status(500).json({ error: "Could not load this account's access token" });
      return;
    }

    const result = await adapter.getDirectMessages(conversationId, accessToken as string);
    const messages = result.messages.map((m) => ({ ...m, isOwn: m.fromId === account.platform_account_id }));
    res.json({ messages, errorMessage: result.errorMessage });
  });

  router.post("/dms/reply", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { socialAccountId, recipientId, text } = req.body as { socialAccountId?: string; recipientId?: string; text?: string };
    if (!socialAccountId || !recipientId || !text?.trim()) {
      res.status(400).json({ error: "socialAccountId, recipientId, and text are all required" });
      return;
    }

    const { data: account, error } = await req.db!
      .from("social_accounts")
      .select("account_id, platform, access_token_vault_id")
      .eq("id", socialAccountId)
      .maybeSingle();
    if (error) {
      dbError(res, error, "POST /dms/reply");
      return;
    }
    if (!account || account.account_id !== req.accountId) {
      res.status(404).json({ error: "Social account not found" });
      return;
    }

    const adapter = registry.get(account.platform);
    if (!adapter?.sendDirectMessage) {
      res.status(400).json({ error: `DMs aren't supported on ${account.platform}` });
      return;
    }

    // read_social_token: service_role-only grant, see the comment on GET
    // /social-accounts/:id/boards above (0003_fix_function_grants.sql).
    const { data: accessToken } = await supabase.rpc("read_social_token", { p_vault_id: account.access_token_vault_id });
    if (!accessToken) {
      res.status(500).json({ error: "Could not load this account's access token" });
      return;
    }

    const result = await adapter.sendDirectMessage(recipientId, text.trim(), accessToken as string);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Send failed" });
      return;
    }
    res.json({ success: true });
  });

  // DM automation — priority (5). CRUD only here; the actual comment
  // watching + sending happens in the standalone dmAutomationPoller.ts
  // script (same external-process pattern as metricsPoller.ts), not
  // in-process, so it keeps running on its own schedule independent of
  // the API server's lifecycle.
  router.post("/dm-automations", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { socialAccountId, scheduledPostId, keyword, dmMessage } = req.body as {
      socialAccountId?: string;
      scheduledPostId?: string | null;
      keyword?: string | null;
      dmMessage?: string;
    };
    if (!socialAccountId || !dmMessage?.trim()) {
      res.status(400).json({ error: "socialAccountId and dmMessage are required" });
      return;
    }

    const { data: account } = await req.db!
      .from("social_accounts")
      .select("account_id, platform")
      .eq("id", socialAccountId)
      .maybeSingle();
    if (!account || account.account_id !== req.accountId) {
      res.status(404).json({ error: "Social account not found" });
      return;
    }
    const adapter = registry.get(account.platform);
    if (!adapter?.sendPrivateReply) {
      res.status(400).json({ error: `DM automation isn't supported on ${account.platform}` });
      return;
    }

    if (scheduledPostId) {
      const { data: post } = await req.db!.from("scheduled_posts").select("account_id").eq("id", scheduledPostId).maybeSingle();
      if (!post || post.account_id !== req.accountId) {
        res.status(404).json({ error: "Post not found" });
        return;
      }
    }

    const { data, error } = await req.db!
      .from("dm_automations")
      .insert({
        account_id: req.accountId,
        social_account_id: socialAccountId,
        scheduled_post_id: scheduledPostId ?? null,
        keyword: keyword?.trim() || null,
        dm_message: dmMessage.trim(),
      })
      .select("id, social_account_id, scheduled_post_id, keyword, dm_message, active, created_at")
      .single();
    if (error) {
      dbError(res, error, "POST /dm-automations");
      return;
    }
    res.status(201).json(data);
  });

  router.get("/dm-automations", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await req.db!
      .from("dm_automations")
      .select("id, social_account_id, scheduled_post_id, keyword, dm_message, active, created_at, social_accounts(platform, display_name)")
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: false });
    if (error) {
      dbError(res, error, "GET /dm-automations");
      return;
    }
    res.json(data ?? []);
  });

  router.delete("/dm-automations/:id", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: automation } = await req.db!.from("dm_automations").select("account_id").eq("id", req.params.id).maybeSingle();
    if (!automation || automation.account_id !== req.accountId) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    const { error } = await req.db!.from("dm_automations").delete().eq("id", req.params.id);
    if (error) {
      dbError(res, error, "DELETE /dm-automations/:id");
      return;
    }
    res.status(204).end();
  });

  return router;
}
