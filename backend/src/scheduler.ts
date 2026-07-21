import { supabase } from "./supabase.js";
import type { PlatformAdapter } from "./platforms/types.js";

const CLAIM_BATCH_SIZE = 10;

interface DuePost {
  id: string;
  account_id: string;
  social_account_id: string;
  content: string;
  media_url: string | null;
}

/** Finds posts due to go out and claims them (status pending -> posting)
 *  so a second concurrent run of this poller can't double-post the same
 *  row — same claim-before-act discipline as the lock/race-condition fix
 *  already proven necessary in Lazy Download's own social automation. */
async function claimDuePosts(): Promise<DuePost[]> {
  const { data: due, error: selectError } = await supabase
    .from("scheduled_posts")
    .select("id, account_id, social_account_id, content, media_url")
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString())
    .limit(CLAIM_BATCH_SIZE);

  if (selectError) throw selectError;
  if (!due || due.length === 0) return [];

  const ids = due.map((p) => p.id);
  const { error: claimError } = await supabase
    .from("scheduled_posts")
    .update({ status: "posting" })
    .in("id", ids)
    .eq("status", "pending"); // only claims rows still pending — a concurrent
  // poller that already claimed one of these ids simply updates 0 rows for it.

  if (claimError) throw claimError;
  return due;
}

async function getAccessToken(socialAccountId: string): Promise<string> {
  const { data: account, error } = await supabase
    .from("social_accounts")
    .select("access_token_vault_id")
    .eq("id", socialAccountId)
    .single();
  if (error || !account) throw error ?? new Error("social account not found");

  const { data: token, error: readError } = await supabase.rpc("read_social_token", {
    p_vault_id: account.access_token_vault_id,
  });
  if (readError) throw readError;
  return token as string;
}

async function processPost(post: DuePost, adapter: PlatformAdapter): Promise<void> {
  try {
    const accessToken = await getAccessToken(post.social_account_id);

    const attempt = await adapter.post({
      socialAccountId: post.social_account_id,
      content: post.content,
      mediaUrl: post.media_url,
      accessToken,
    });

    if (!attempt.success || !attempt.platformPostId) {
      await markFailed(post.id, attempt.errorMessage ?? "post attempt failed, no reason given");
      return;
    }

    // The post API call succeeding is NOT the same as the content being
    // live — this read-back check is the actual Proof-of-Publish
    // differentiator, not an optional extra step.
    const verification = await adapter.verifyPublished(attempt.platformPostId, accessToken);

    await supabase.from("post_results").insert({
      scheduled_post_id: post.id,
      account_id: post.account_id,
      platform_post_id: attempt.platformPostId,
      platform_post_url: verification.platformPostUrl,
      verified_live: verification.verifiedLive,
      verification_checked_at: new Date().toISOString(),
      error_message: verification.errorMessage,
    });

    await supabase
      .from("scheduled_posts")
      .update({ status: verification.verifiedLive ? "posted" : "failed" })
      .eq("id", post.id);
  } catch (err) {
    await markFailed(post.id, err instanceof Error ? err.message : String(err));
  }
}

async function markFailed(postId: string, message: string): Promise<void> {
  await supabase.from("scheduled_posts").update({ status: "failed" }).eq("id", postId);
  console.error(`Post ${postId} failed: ${message}`);
}

/** One poll cycle: claim whatever's due, process each post. Call this on
 *  an interval (or from a cron trigger) — it does not loop internally. */
export async function runSchedulerCycle(adapter: PlatformAdapter): Promise<void> {
  const due = await claimDuePosts();
  if (due.length === 0) return;

  console.log(`Claimed ${due.length} due post(s).`);
  for (const post of due) {
    await processPost(post, adapter);
  }
}
