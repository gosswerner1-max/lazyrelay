import { supabase } from "./supabase.js";
import type { PlatformAdapter } from "./platforms/types.js";
import { notifyOps } from "./notify.js";

const CLAIM_BATCH_SIZE = 10;

// A post that fails gets retried with exponential backoff before being
// marked permanently failed — a one-off network blip or momentary platform
// error shouldn't kill a post that would have gone through on a later
// attempt. 3 retries at 2/4/8 minutes, then it's a real failure.
const MAX_RETRIES = 3;
const BACKOFF_BASE_MINUTES = 2;

// Circuit breaker: trips after CONSECUTIVE_FAILURE_THRESHOLD failures in a
// row for a given platform, pausing all posting to that platform for
// BREAKER_COOLDOWN_MS. This isn't (only) about the failing customer's own
// posts — hammering a platform that's already rejecting/rate-limiting us
// risks LazyRelay's own app-level API access getting throttled or flagged,
// which would degrade service for every customer on that platform, not
// just the one whose posts are currently failing.
const CONSECUTIVE_FAILURE_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 5 * 60_000;

interface BreakerState {
  consecutiveFailures: number;
  trippedUntil: number | null;
}
const breakers = new Map<string, BreakerState>();

function getBreaker(platform: string): BreakerState {
  let state = breakers.get(platform);
  if (!state) {
    state = { consecutiveFailures: 0, trippedUntil: null };
    breakers.set(platform, state);
  }
  return state;
}

/** True if the breaker is currently open for this platform. A breaker
 *  whose cooldown has elapsed resets itself here and gives the platform
 *  another chance, rather than staying tripped forever. */
function isBreakerTripped(platform: string): boolean {
  const state = getBreaker(platform);
  if (!state.trippedUntil) return false;
  if (state.trippedUntil > Date.now()) return true;
  state.consecutiveFailures = 0;
  state.trippedUntil = null;
  return false;
}

function recordSuccess(platform: string): void {
  const state = getBreaker(platform);
  state.consecutiveFailures = 0;
  state.trippedUntil = null;
}

function recordFailure(platform: string): void {
  const state = getBreaker(platform);
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD && !state.trippedUntil) {
    state.trippedUntil = Date.now() + BREAKER_COOLDOWN_MS;
    void notifyOps(
      `Circuit breaker tripped for platform "${platform}" after ${state.consecutiveFailures} consecutive failures — ` +
        `pausing all posting to this platform for ${BREAKER_COOLDOWN_MS / 60_000} minutes.`
    );
  }
}

interface DuePost {
  id: string;
  account_id: string;
  social_account_id: string;
  content: string;
  media_url: string | null;
  retry_count: number;
}

/** Finds posts due to go out and claims them (status pending -> posting)
 *  so a second concurrent run of this poller can't double-post the same
 *  row — same claim-before-act discipline as the lock/race-condition fix
 *  already proven necessary in Lazy Download's own social automation. */
async function claimDuePosts(): Promise<DuePost[]> {
  const { data: due, error: selectError } = await supabase
    .from("scheduled_posts")
    .select("id, account_id, social_account_id, content, media_url, retry_count")
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

/** A failure that hasn't exhausted its retries goes back to `pending` with
 *  an exponential backoff delay instead of being marked `failed` outright.
 *  Only once MAX_RETRIES is exhausted does this become a real, alerted
 *  failure — this is what actually backs the Proof-of-Publish promise
 *  against transient errors instead of just the happy path. */
async function handleFailure(post: DuePost, message: string): Promise<void> {
  if (post.retry_count < MAX_RETRIES) {
    const backoffMinutes = BACKOFF_BASE_MINUTES * 2 ** post.retry_count;
    const nextAttempt = new Date(Date.now() + backoffMinutes * 60_000).toISOString();
    await supabase
      .from("scheduled_posts")
      .update({ status: "pending", retry_count: post.retry_count + 1, scheduled_for: nextAttempt })
      .eq("id", post.id);
    console.warn(
      `Post ${post.id} failed (attempt ${post.retry_count + 1}/${MAX_RETRIES + 1}): ${message}. Retrying at ${nextAttempt}.`
    );
    return;
  }

  await supabase.from("scheduled_posts").update({ status: "failed" }).eq("id", post.id);
  console.error(`Post ${post.id} permanently failed after ${MAX_RETRIES + 1} attempts: ${message}`);
  await notifyOps(`Post ${post.id} permanently failed after ${MAX_RETRIES + 1} attempts: ${message}`);
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
      recordFailure(adapter.platform);
      await handleFailure(post, attempt.errorMessage ?? "post attempt failed, no reason given");
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

    if (!verification.verifiedLive) {
      recordFailure(adapter.platform);
      await handleFailure(post, verification.errorMessage ?? "post published but verification could not confirm it went live");
      return;
    }

    recordSuccess(adapter.platform);
    await supabase.from("scheduled_posts").update({ status: "posted" }).eq("id", post.id);
  } catch (err) {
    recordFailure(adapter.platform);
    await handleFailure(post, err instanceof Error ? err.message : String(err));
  }
}

/** One poll cycle: claim whatever's due, process each post. Call this on
 *  an interval (or from a cron trigger) — it does not loop internally.
 *  Skips claiming entirely while this platform's circuit breaker is open,
 *  so posts stay untouched (still pending) rather than being claimed into
 *  a stuck "posting" state during a known outage. */
export async function runSchedulerCycle(adapter: PlatformAdapter): Promise<void> {
  if (isBreakerTripped(adapter.platform)) {
    console.warn(`Skipping scheduler cycle — circuit breaker open for platform "${adapter.platform}".`);
    return;
  }

  const due = await claimDuePosts();
  if (due.length === 0) return;

  console.log(`Claimed ${due.length} due post(s).`);
  for (const post of due) {
    await processPost(post, adapter);
  }
}
