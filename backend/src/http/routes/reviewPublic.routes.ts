// Client review links, the client's side (master list #23). No login: the link's token is
// the only credential. A client sees ONLY the posts waiting for approval on that account
// (and the ones they approved through this link), and can approve, ask for changes, or
// comment. Every route answers the same 404 for a bad, expired or revoked link, so a
// guessed token learns nothing.

import { Router } from "express";
import { supabase } from "../../supabase.js";
import { publicRateLimit } from "../rateLimit.js";
import { dbError, resolveBrandFilterSocialAccountIds } from "./shared.js";
import { syncPostToCalendar } from "../../googleCalendar/outboundSync.js";
import { syncAccountSheet } from "../../googleSheets/outboundSync.js";
import { sendReviewActivityEmail } from "../../email.js";
import { cleanName, cleanComment, loadUsableLink, MAX_COMMENTS_PER_POST, MAX_POSTS_ON_REVIEW_PAGE, type ReviewLinkRow } from "../../reviewLinks.js";

const NOT_VALID = { error: "This review link isn't valid, or it has expired." };
const POST_COLUMNS = "id, content, media_url, media_urls, scheduled_for, status, changes_requested_at, options, social_account_id, social_accounts(platform, display_name)";
const THROTTLE_MS = 10 * 60_000;

interface PostRow {
  id: string;
  content: string;
  media_url: string | null;
  media_urls: string[] | null;
  scheduled_for: string | null;
  status: string;
  changes_requested_at: string | null;
  options: unknown;
  social_account_id: string | null;
  social_accounts: { platform?: string; display_name?: string | null } | Array<{ platform?: string; display_name?: string | null }> | null;
}

const embedOf = (p: PostRow) => (Array.isArray(p.social_accounts) ? p.social_accounts[0] : p.social_accounts) ?? {};

export function buildReviewPublicRouter(): Router {
  const router = Router();

  // The social account ids this link may see (its brand, if it has one), or undefined for all.
  async function allowedAccountIds(link: ReviewLinkRow): Promise<string[] | undefined> {
    return link.brand_label ? resolveBrandFilterSocialAccountIds(link.account_id, link.brand_label) : undefined;
  }

  // One post the client may act on: on this link's account, inside its brand, and still waiting for approval.
  async function findWaitingPost(link: ReviewLinkRow, postId: string): Promise<PostRow | null> {
    const { data } = await supabase.from("scheduled_posts").select(POST_COLUMNS).eq("id", postId).eq("account_id", link.account_id).eq("status", "needs_approval").maybeSingle();
    const post = data as PostRow | null;
    if (!post) return null;
    const ids = await allowedAccountIds(link);
    if (ids && (!post.social_account_id || !ids.includes(post.social_account_id))) return null;
    return post;
  }

  async function ownerEmail(accountId: string): Promise<string | null> {
    const { data } = await supabase.from("accounts").select("email").eq("id", accountId).maybeSingle();
    return (data?.email as string | null) ?? null;
  }

  router.get("/public/review/:token", publicRateLimit, async (req, res) => {
    const link = await loadUsableLink(req.params.token);
    if (!link) {
      res.status(404).json(NOT_VALID);
      return;
    }
    try {
      const ids = await allowedAccountIds(link);
      let waitingQuery = supabase.from("scheduled_posts").select(POST_COLUMNS).eq("account_id", link.account_id).eq("status", "needs_approval").order("scheduled_for", { ascending: true }).limit(MAX_POSTS_ON_REVIEW_PAGE);
      if (ids) waitingQuery = waitingQuery.in("social_account_id", ids);
      const { data: waiting, error } = await waitingQuery;
      if (error) throw error;

      // Posts this client already approved through this link stay visible, marked approved.
      const { data: approvals } = await supabase.from("post_review_comments").select("post_id").eq("review_link_id", link.id).eq("kind", "approved");
      const approvedIds = [...new Set((approvals ?? []).map((a) => a.post_id as string))].filter((id) => !((waiting ?? []) as PostRow[]).some((w) => w.id === id));
      let approvedPosts: PostRow[] = [];
      if (approvedIds.length > 0) {
        const { data } = await supabase.from("scheduled_posts").select(POST_COLUMNS).eq("account_id", link.account_id).in("id", approvedIds.slice(0, MAX_POSTS_ON_REVIEW_PAGE));
        approvedPosts = (data ?? []) as PostRow[];
      }

      const posts = [...((waiting ?? []) as PostRow[]), ...approvedPosts];
      const postIds = posts.map((p) => p.id);
      const { data: comments } = postIds.length
        ? await supabase.from("post_review_comments").select("post_id, author_kind, author_name, kind, body, created_at").in("post_id", postIds).order("created_at", { ascending: true })
        : { data: [] };
      const byPost = new Map<string, unknown[]>();
      for (const c of comments ?? []) {
        const list = byPost.get(c.post_id as string) ?? [];
        list.push({ authorKind: c.author_kind, authorName: c.author_name, kind: c.kind, body: c.body, createdAt: c.created_at });
        byPost.set(c.post_id as string, list);
      }

      const { data: account } = await supabase.from("accounts").select("business_name").eq("id", link.account_id).maybeSingle();
      void supabase.from("review_links").update({ last_viewed_at: new Date().toISOString() }).eq("id", link.id);

      res.json({
        businessName: (account?.business_name as string | null) ?? null,
        label: link.label,
        expiresAt: link.expires_at,
        posts: posts.map((p) => ({
          id: p.id,
          content: p.content,
          mediaUrl: p.media_url,
          mediaUrls: p.media_urls ?? [],
          scheduledFor: p.scheduled_for,
          platform: embedOf(p).platform ?? null,
          accountName: embedOf(p).display_name ?? null,
          state: p.status === "needs_approval" ? (p.changes_requested_at ? "changes_requested" : "waiting") : "approved",
          options: p.options ?? {},
          comments: byPost.get(p.id) ?? [],
        })),
      });
    } catch (err) {
      dbError(res, err as { message: string }, "GET /public/review/:token");
    }
  });

  async function record(link: ReviewLinkRow, postId: string, name: string, kind: "comment" | "approved" | "changes_requested", body: string | null): Promise<string | null> {
    const { error } = await supabase.from("post_review_comments").insert({
      account_id: link.account_id,
      post_id: postId,
      review_link_id: link.id,
      author_kind: "reviewer",
      author_name: name,
      kind,
      body,
    });
    return error ? error.message : null;
  }

  async function underCommentCap(postId: string): Promise<boolean> {
    const { count } = await supabase.from("post_review_comments").select("id", { count: "exact", head: true }).eq("post_id", postId);
    return (count ?? 0) < MAX_COMMENTS_PER_POST;
  }

  router.post("/public/review/:token/posts/:postId/approve", publicRateLimit, async (req, res) => {
    const link = await loadUsableLink(req.params.token);
    if (!link) {
      res.status(404).json(NOT_VALID);
      return;
    }
    const name = cleanName((req.body ?? {}).name);
    if (!name.ok) {
      res.status(400).json({ error: name.error });
      return;
    }
    const post = await findWaitingPost(link, String(req.params.postId));
    if (!post) {
      res.status(409).json({ error: "This post is no longer waiting for approval." });
      return;
    }
    // Atomic: only a post still waiting can be approved, so two clicks or two reviewers approve it once.
    const { data: updated, error } = await supabase
      .from("scheduled_posts")
      .update({ status: "pending", changes_requested_at: null }, { count: "exact" })
      .eq("id", post.id)
      .eq("account_id", link.account_id)
      .eq("status", "needs_approval")
      .select("id")
      .maybeSingle();
    if (error) {
      dbError(res, error, "POST /public/review/:token/posts/:postId/approve");
      return;
    }
    if (!updated) {
      res.status(409).json({ error: "This post is no longer waiting for approval." });
      return;
    }
    const recordError = await record(link, post.id, name.name, "approved", null);
    if (recordError) console.error("[review] could not record approval:", recordError);
    void syncPostToCalendar(post.id);
    void syncAccountSheet(link.account_id);
    const to = await ownerEmail(link.account_id);
    if (to) sendReviewActivityEmail(to, { action: "approved", reviewer: name.name, postText: post.content, comment: null });
    res.json({ approved: true });
  });

  router.post("/public/review/:token/posts/:postId/changes", publicRateLimit, async (req, res) => {
    const link = await loadUsableLink(req.params.token);
    if (!link) {
      res.status(404).json(NOT_VALID);
      return;
    }
    const name = cleanName((req.body ?? {}).name);
    if (!name.ok) {
      res.status(400).json({ error: name.error });
      return;
    }
    const comment = cleanComment((req.body ?? {}).comment, true);
    if (!comment.ok) {
      res.status(400).json({ error: comment.error });
      return;
    }
    const post = await findWaitingPost(link, String(req.params.postId));
    if (!post) {
      res.status(409).json({ error: "This post is no longer waiting for approval." });
      return;
    }
    if (!(await underCommentCap(post.id))) {
      res.status(400).json({ error: "This conversation is full. Please contact the sender directly." });
      return;
    }
    // Throttle the email, not the request: several change requests in a row send one message.
    const { data: recent } = await supabase.from("post_review_comments").select("created_at").eq("post_id", post.id).eq("kind", "changes_requested").order("created_at", { ascending: false }).limit(1);
    const lastAt = recent?.[0]?.created_at ? new Date(recent[0].created_at as string).getTime() : 0;

    await supabase.from("scheduled_posts").update({ changes_requested_at: new Date().toISOString() }).eq("id", post.id).eq("account_id", link.account_id).eq("status", "needs_approval");
    const recordError = await record(link, post.id, name.name, "changes_requested", comment.body);
    if (recordError) {
      dbError(res, { message: recordError }, "POST /public/review/:token/posts/:postId/changes");
      return;
    }
    if (Date.now() - lastAt > THROTTLE_MS) {
      const to = await ownerEmail(link.account_id);
      if (to) sendReviewActivityEmail(to, { action: "changes_requested", reviewer: name.name, postText: post.content, comment: comment.body });
    }
    res.json({ recorded: true });
  });

  router.post("/public/review/:token/posts/:postId/comments", publicRateLimit, async (req, res) => {
    const link = await loadUsableLink(req.params.token);
    if (!link) {
      res.status(404).json(NOT_VALID);
      return;
    }
    const name = cleanName((req.body ?? {}).name);
    if (!name.ok) {
      res.status(400).json({ error: name.error });
      return;
    }
    const comment = cleanComment((req.body ?? {}).comment, true);
    if (!comment.ok) {
      res.status(400).json({ error: comment.error });
      return;
    }
    const post = await findWaitingPost(link, String(req.params.postId));
    if (!post) {
      res.status(409).json({ error: "This post is no longer waiting for approval." });
      return;
    }
    if (!(await underCommentCap(post.id))) {
      res.status(400).json({ error: "This conversation is full. Please contact the sender directly." });
      return;
    }
    const recordError = await record(link, post.id, name.name, "comment", comment.body);
    if (recordError) {
      dbError(res, { message: recordError }, "POST /public/review/:token/posts/:postId/comments");
      return;
    }
    res.status(201).json({ recorded: true });
  });

  return router;
}
