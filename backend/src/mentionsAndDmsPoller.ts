// Mentions/DMs — the polling half. Not a server process; run periodically
// by an external scheduled task, same pattern as metricsPoller.ts and
// dmAutomationPoller.ts. This is the ONLY place that still calls out live
// to each platform for comments/conversations — GET /mentions and GET
// /dms both read from the cache tables this writes, and the notification
// bell is powered by the same cache. See migration
// 0058_mentions_dms_cache.sql and werner-brain's 2026-08-20 daily note for
// why (a bell that checked live platforms on every page load would be a
// real rate-limit risk once there's real customer traffic).
import "dotenv/config";
import { supabase } from "./supabase.js";
import { buildPlatformRegistry } from "./platforms/registry.js";
import { getAccessToken } from "./scheduler.js";
import { triageItems } from "./commentTriage.js";

// Mirrors dmAutomationPoller's own 30-day "all posts" window — comments on
// an older post essentially never get new activity, and bounding this is
// what keeps a single run's live-call volume finite as post history grows.
const MENTIONS_POLL_WINDOW_MS = 30 * 24 * 3600_000;

// Real outbound calls per run, same reasoning as metricsPoller's
// MAX_POLLS_PER_RUN — this spends each customer's own platform rate-limit
// budget, not LazyRelay's. Higher than the other pollers' caps because this
// one covers every account's posts/DMs each run, not just active
// automations.
const MAX_MENTION_POST_POLLS_PER_RUN = 300;
const MAX_DM_ACCOUNT_POLLS_PER_RUN = 300;

function extractPlatform(social_accounts: unknown): string | null {
  if (Array.isArray(social_accounts)) return (social_accounts[0] as { platform?: string } | undefined)?.platform ?? null;
  return (social_accounts as { platform?: string } | null)?.platform ?? null;
}

interface MentionPostRow {
  id: string;
  account_id: string;
  social_account_id: string;
  social_accounts: { platform?: string } | { platform?: string }[] | null;
  post_results: { platform_post_id: string | null; verified_live: boolean }[] | { platform_post_id: string | null; verified_live: boolean } | null;
}

async function pollMentions(registry: ReturnType<typeof buildPlatformRegistry>) {
  const since = new Date(Date.now() - MENTIONS_POLL_WINDOW_MS).toISOString();
  const { data: posts, error } = await supabase
    .from("scheduled_posts")
    .select("id, account_id, social_account_id, social_accounts(platform), post_results(platform_post_id, verified_live)")
    .eq("status", "posted")
    .gte("scheduled_for", since)
    .order("scheduled_for", { ascending: false })
    .limit(1000);
  if (error) {
    console.error("mentionsAndDmsPoller: failed to read scheduled_posts:", error.message);
    return { postsPolled: 0, commentsCached: 0, errored: 0 };
  }

  let postsPolled = 0;
  let commentsCached = 0;
  let errored = 0;

  for (const post of (posts ?? []) as unknown as MentionPostRow[]) {
    if (postsPolled >= MAX_MENTION_POST_POLLS_PER_RUN) break;

    const platform = extractPlatform(post.social_accounts);
    const results_ = Array.isArray(post.post_results) ? post.post_results : post.post_results ? [post.post_results] : [];
    const live = results_.find((r) => r.verified_live && r.platform_post_id);
    if (!platform || !live?.platform_post_id) continue;

    const adapter = registry.get(platform);
    if (!adapter?.getComments) continue;

    let accessToken: string;
    try {
      accessToken = await getAccessToken(post.social_account_id, adapter);
    } catch (err) {
      console.error(`mentionsAndDmsPoller: could not get access token for post ${post.id}:`, err instanceof Error ? err.message : err);
      errored += 1;
      continue;
    }

    postsPolled += 1;
    try {
      const commentsResult = await adapter.getComments(live.platform_post_id, accessToken);

      // Pre-warm the shared triage cache (commentTriage.ts) so GET
      // /mentions never has to wait on a live classification call — by the
      // time a customer opens the tab, every cached comment already has a
      // triage verdict sitting in comment_triage.
      await triageItems(
        post.account_id,
        "comment",
        commentsResult.comments.map((c) => ({ itemId: c.id, sourceSignature: c.id, author: c.author, text: c.text })),
      );

      for (const c of commentsResult.comments) {
        const { error: upsertError } = await supabase.from("mention_comments_cache").upsert(
          {
            account_id: post.account_id,
            scheduled_post_id: post.id,
            social_account_id: post.social_account_id,
            platform_comment_id: c.id,
            author: c.author,
            text: c.text,
            url: c.url,
            comment_created_at: c.createdAt,
            fetched_at: new Date().toISOString(),
            // first_seen_at deliberately omitted — the column default only
            // applies on first insert; leaving it out of this payload means
            // an existing row's original value survives the ON CONFLICT
            // update untouched.
          },
          { onConflict: "scheduled_post_id,platform_comment_id" },
        );
        if (upsertError) {
          console.error(`mentionsAndDmsPoller: failed to cache comment ${c.id}:`, upsertError.message);
          continue;
        }
        commentsCached += 1;
      }
    } catch (err) {
      console.error(`mentionsAndDmsPoller: getComments failed for post ${post.id}:`, err instanceof Error ? err.message : err);
      errored += 1;
    }
  }

  return { postsPolled, commentsCached, errored };
}

interface DmAccountRow {
  id: string;
  account_id: string;
  platform: string;
}

async function pollDms(registry: ReturnType<typeof buildPlatformRegistry>) {
  const { data: accounts, error } = await supabase
    .from("social_accounts")
    .select("id, account_id, platform")
    .is("disconnected_at", null)
    .limit(1000);
  if (error) {
    console.error("mentionsAndDmsPoller: failed to read social_accounts:", error.message);
    return { accountsPolled: 0, conversationsCached: 0, errored: 0 };
  }

  let accountsPolled = 0;
  let conversationsCached = 0;
  let errored = 0;

  for (const account of (accounts ?? []) as unknown as DmAccountRow[]) {
    if (accountsPolled >= MAX_DM_ACCOUNT_POLLS_PER_RUN) break;

    const adapter = registry.get(account.platform);
    if (!adapter?.getConversations) continue;

    let accessToken: string;
    try {
      accessToken = await getAccessToken(account.id, adapter);
    } catch (err) {
      console.error(`mentionsAndDmsPoller: could not get access token for social account ${account.id}:`, err instanceof Error ? err.message : err);
      errored += 1;
      continue;
    }

    accountsPolled += 1;
    try {
      const convResult = await adapter.getConversations(accessToken);

      await triageItems(
        account.account_id,
        "dm",
        convResult.conversations.filter((c) => !!c.snippet).map((c) => ({ itemId: c.id, sourceSignature: c.updatedAt ?? "", author: c.participantName, text: c.snippet! })),
      );

      for (const c of convResult.conversations) {
        const { error: upsertError } = await supabase.from("dm_conversations_cache").upsert(
          {
            account_id: account.account_id,
            social_account_id: account.id,
            conversation_id: c.id,
            participant_id: c.participantId,
            participant_name: c.participantName,
            snippet: c.snippet,
            // Always overwritten (unlike mentions' comment_created_at) — see
            // the migration's own comment on this table for why.
            conversation_updated_at: c.updatedAt,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: "social_account_id,conversation_id" },
        );
        if (upsertError) {
          console.error(`mentionsAndDmsPoller: failed to cache conversation ${c.id}:`, upsertError.message);
          continue;
        }
        conversationsCached += 1;
      }
    } catch (err) {
      console.error(`mentionsAndDmsPoller: getConversations failed for social account ${account.id}:`, err instanceof Error ? err.message : err);
      errored += 1;
    }
  }

  return { accountsPolled, conversationsCached, errored };
}

async function main() {
  const registry = buildPlatformRegistry();
  const mentions = await pollMentions(registry);
  const dms = await pollDms(registry);
  console.log(
    `mentionsAndDmsPoller: mentions — ${mentions.postsPolled} posts polled, ${mentions.commentsCached} comments cached, ${mentions.errored} errors. ` +
      `dms — ${dms.accountsPolled} accounts polled, ${dms.conversationsCached} conversations cached, ${dms.errored} errors.`,
  );
}

main().catch((err) => {
  console.error("mentionsAndDmsPoller: unhandled error:", err);
  process.exit(1);
});
