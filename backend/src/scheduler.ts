import { runChain } from "./chainRunner.js";
import { supabase } from "./supabase.js";
import type { PlatformAdapterRegistry } from "./platforms/connect.js";
import type { PlatformAdapter, PostAttemptResult } from "./platforms/types.js";
import { notifyOps } from "./notify.js";
import { clearReconnect, flagReconnect, isPermanentAuthError, platformLabel } from "./tokenHealth.js";
import { classifyPostError, PINTEREST_BLOCKED_LINK_MESSAGE, PINTEREST_BLOCKED_LINK_PATTERN, type PostErrorKind } from "./postErrors.js";
import { resolvePostLimitAt } from "./pinterestWarmup.js";
import { sendFailureAlert, sendAccountPausedAlert, sendPinterestPausedAlert } from "./email.js";
import { dispatchWebhookEvent } from "./webhook.js";
import {
  ROLLING_WINDOW_MS,
  getRolling24hPostLimit,
  nextAllowedTime,
  wouldExceedRolling24hLimit,
} from "./platformPostLimits.js";
import { resolveTier, type Tier } from "./tier.js";
import { MAX_FIRST_COMMENT_LENGTH } from "./postCreation.js";
import { decideFirstComment, firstCommentDueAt } from "./firstCommentDelay.js";

// How many due posts one scheduler cycle claims and processes. Combined
// with index.ts's POLL_INTERVAL_MS, this is the real throughput ceiling —
// confirmed live 2026-08-21 at ~20 posts/min (10 every 30s), while Render's
// own CPU/memory stayed flat even at 8x that batch size processed fully
// concurrently. Not a hardware limit — raise this env var on Render (no
// code change, no redeploy of new code, just the setting) once real volume
// approaches the current ceiling. Defaults to the original hardcoded value,
// so leaving it unset changes nothing.
const CLAIM_BATCH_SIZE = Number(process.env.SCHEDULER_CLAIM_BATCH_SIZE) || 10;

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

// Proactive rate limiting -- added 2026-08-21, a real gap found during a
// scaling review (not hypothetical): the circuit breaker above is purely
// reactive, only engaging after CONSECUTIVE_FAILURE_THRESHOLD calls have
// already failed. Nothing stopped a burst of posts scheduled for the same
// popular time (everyone wants "9am") from firing at a single platform as
// fast as claimDuePosts() could hand them out, which is exactly the
// "hammering a platform" risk the circuit breaker's own comment already
// names -- LazyRelay's own app-level API access getting throttled or
// flagged degrades the product for every customer on that platform, not
// just whoever's posts triggered it. This caps outbound calls per
// platform per rolling window, in-process, same Map-keyed-by-platform
// shape as the breaker above. Deliberately conservative defaults --
// tune per platform once real traffic gives a reason to, not meant to
// mirror each platform's exact documented ceiling from day one.
const RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_CALLS_PER_WINDOW = 30;
const PLATFORM_MAX_CALLS_PER_WINDOW: Record<string, number> = {};

interface RateLimitState {
  windowStart: number;
  count: number;
}
const rateLimiters = new Map<string, RateLimitState>();

/** Checks AND consumes a slot atomically, same shape as a token-bucket
 *  tryAcquire -- true means the platform's budget for the current window
 *  is already used up (no slot was consumed); false means a slot was just
 *  taken and the caller may proceed. Exported for test-rate-limiter.ts --
 *  a pure, fast, non-DB unit test is the right shape for this boundary
 *  logic (an integration test through runSchedulerCycle would tangle the
 *  assertion with claimDuePosts' own CLAIM_BATCH_SIZE batching, which
 *  tests a different thing). */
export function isRateLimited(platform: string): boolean {
  const max = PLATFORM_MAX_CALLS_PER_WINDOW[platform] ?? DEFAULT_MAX_CALLS_PER_WINDOW;
  const now = Date.now();
  let state = rateLimiters.get(platform);
  if (!state || now - state.windowStart >= RATE_LIMIT_WINDOW_MS) {
    state = { windowStart: now, count: 0 };
    rateLimiters.set(platform, state);
  }
  if (state.count >= max) return true;
  state.count += 1;
  return false;
}

interface DuePost {
  id: string;
  account_id: string;
  social_account_id: string;
  content: string;
  media_url: string | null;
  media_urls: string[] | null;
  options: import("./postOptions.js").PostOptions | null;
  cover_image_url: string | null;
  board_id: string | null;
  destination_link: string | null;
  first_comment: string | null;
  media_alt_text: string | null;
  tiktok_privacy_level: string | null;
  tiktok_disable_comment: boolean;
  tiktok_disable_duet: boolean;
  tiktok_disable_stitch: boolean;
  tiktok_brand_organic: boolean;
  tiktok_brand_content: boolean;
  retry_count: number;
  platform: string;
  platform_account_id?: string | null;
}

/** Finds posts due to go out and claims them (status pending -> posting)
 *  so a second concurrent run of this poller can't double-post the same
 *  row — same claim-before-act discipline as the lock/race-condition fix
 *  already proven necessary in Lazy Download's own social automation.
 *  Joins social_accounts for platform so a single cycle can dispatch each
 *  post to the right adapter instead of assuming one platform for everything. */
async function claimDuePosts(): Promise<DuePost[]> {
  const { data: due, error: selectError } = await supabase
    .from("scheduled_posts")
    .select("id")
    .eq("status", "pending")
    .is("paused_at", null)
    .lte("scheduled_for", new Date().toISOString())
    .limit(CLAIM_BATCH_SIZE);

  if (selectError) throw selectError;
  if (!due || due.length === 0) return [];

  const ids = due.map((p) => p.id);
  // The UPDATE's own `.select()` return value — NOT the earlier SELECT's
  // `due` list — is the only trustworthy source of what this call actually
  // claimed. A stress test (10 concurrent scheduler cycles racing one due
  // post) proved the earlier version wrong: every concurrent call re-used
  // its own pre-update `due` snapshot regardless of whether its UPDATE
  // affected 0 or 1 rows, so 9 of 10 concurrent cycles double-processed
  // the same post. `.eq("status","pending")` on the UPDATE still only
  // flips rows atomically at the DB layer, but the row only belongs to a
  // caller whose UPDATE's `.select()` actually returned it back.
  const { data: claimed, error: claimError } = await supabase
    .from("scheduled_posts")
    .update({ status: "posting" })
    .in("id", ids)
    .eq("status", "pending")
    .is("paused_at", null)
    .select(
      "id, account_id, social_account_id, content, media_url, media_urls, options, cover_image_url, board_id, destination_link, first_comment, media_alt_text, tiktok_privacy_level, tiktok_disable_comment, tiktok_disable_duet, tiktok_disable_stitch, tiktok_brand_organic, tiktok_brand_content, retry_count, social_accounts(platform, platform_account_id)",
    );

  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) return [];

  return claimed.map((p) => {
    // Supabase's PostgREST client types a to-one embed as an array even
    // though the FK guarantees exactly one row here.
    const account = Array.isArray(p.social_accounts) ? p.social_accounts[0] : p.social_accounts;
    const { social_accounts: _social_accounts, ...rest } = p as typeof p & { social_accounts: unknown };
    return { ...rest, platform: account?.platform, platform_account_id: account?.platform_account_id ?? null } as DuePost;
  });
}

// A token within this many ms of its stated expiry is treated as already
// expired — avoids a race where post() starts with a token that dies
// mid-request instead of catching it here with time to actually refresh.
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface TokenAccountRow {
  id: string;
  account_id: string;
  platform: string;
  display_name: string | null;
  access_token_vault_id: string;
  refresh_token_vault_id: string | null;
  token_expires_at: string | null;
  needs_reconnect_at: string | null;
  reconnect_notified_at: string | null;
}

export const TOKEN_ACCOUNT_COLUMNS =
  "id, account_id, platform, display_name, access_token_vault_id, refresh_token_vault_id, token_expires_at, needs_reconnect_at, reconnect_notified_at";

/** True when the adapter can renew this account's token: either through a
 *  stored refresh token, or in place with the access token itself (Threads). */
export function canRefreshToken(adapter: PlatformAdapter, account: Pick<TokenAccountRow, "refresh_token_vault_id">): boolean {
  return !!adapter.refresh && (!!account.refresh_token_vault_id || !!adapter.refreshUsesAccessToken);
}

/** Runs the adapter's refresh and stores the result. The one refresh path,
 *  used both when a post needs a token and by the daily token job. */
export async function refreshAndStoreToken(account: TokenAccountRow, adapter: PlatformAdapter): Promise<string> {
  if (!adapter.refresh) throw new Error(`${adapter.platform} tokens can't be refreshed`);

  // Threads refreshes in place: the current access token is the credential
  // to renew. Everyone else sends their stored refresh token.
  const sourceVaultId = adapter.refreshUsesAccessToken ? account.access_token_vault_id : account.refresh_token_vault_id;
  const { data: stored, error: refreshReadError } = await supabase.rpc("read_social_token", { p_vault_id: sourceVaultId });
  if (refreshReadError) throw refreshReadError;

  const refreshed = await adapter.refresh(stored as string);

  const { error: updateAccessError } = await supabase.rpc("update_social_token", {
    p_vault_id: account.access_token_vault_id,
    p_new_token: refreshed.accessToken,
  });
  if (updateAccessError) throw updateAccessError;

  // TikTok (and platforms with similar rotation) issues a new refresh
  // token on every use — persist it too, or the NEXT refresh attempt
  // fails with a revoked/already-used token. Falls back to keeping the
  // existing one if the platform didn't return a new one.
  if (refreshed.refreshToken && account.refresh_token_vault_id) {
    const { error: updateRefreshError } = await supabase.rpc("update_social_token", {
      p_vault_id: account.refresh_token_vault_id,
      p_new_token: refreshed.refreshToken,
    });
    if (updateRefreshError) throw updateRefreshError;
  }

  await supabase.from("social_accounts").update({ token_expires_at: refreshed.expiresAt }).eq("id", account.id);
  // A working refresh means any earlier "needs reconnect" flag was wrong or is
  // now resolved.
  if (account.needs_reconnect_at || account.reconnect_notified_at) await clearReconnect(account.id);
  return refreshed.accessToken;
}

/** Reads the stored access token, refreshing it first via adapter.refresh()
 *  if it's expired/near-expiry and the adapter supports refreshing (see
 *  PlatformAdapter.refresh — TikTok confirmed as a real, live gap: access
 *  tokens dead within ~24h with a refresh token captured at connect time
 *  but never used anywhere). Adapters without a refresh() (long-lived or
 *  non-expiring tokens) fall through unchanged — same behavior as before
 *  this existed, EXCEPT that a token whose stated expiry has genuinely
 *  passed and that can't be renewed (LinkedIn, an expired Threads token) now
 *  fails with a clear "reconnect" message and flags the account, instead of
 *  sending a dead token to the platform and retrying it. */
export async function getAccessToken(socialAccountId: string, adapter: PlatformAdapter): Promise<string> {
  const { data: account, error } = await supabase
    .from("social_accounts")
    .select(TOKEN_ACCOUNT_COLUMNS)
    .eq("id", socialAccountId)
    .single();
  if (error || !account) throw error ?? new Error("social account not found");
  const row = account as TokenAccountRow;

  const expiresMs = row.token_expires_at !== null ? new Date(row.token_expires_at).getTime() : null;
  const isExpired = expiresMs !== null && expiresMs - TOKEN_REFRESH_SKEW_MS < Date.now();
  const reallyExpired = expiresMs !== null && expiresMs <= Date.now();

  if (isExpired && canRefreshToken(adapter, row)) {
    // An in-place refresh (Threads) is only possible while the token is still
    // valid; once it has really expired the customer must reconnect.
    if (!adapter.refreshUsesAccessToken || !reallyExpired) {
      try {
        return await refreshAndStoreToken(row, adapter);
      } catch (err) {
        if (isPermanentAuthError(err)) {
          await flagReconnect(row, "The platform rejected the saved login (it was revoked or has expired).", { expired: true });
        }
        throw err;
      }
    }
  }

  if (reallyExpired && (!adapter.refresh || adapter.refreshUsesAccessToken)) {
    const reason = `The ${platformLabel(row.platform)} connection expired on ${row.token_expires_at?.slice(0, 10)}. Reconnect it in Social Platforms.`;
    await flagReconnect(row, reason, { expired: true, expiresAt: row.token_expires_at });
    throw new Error(reason);
  }

  const { data: token, error: readError } = await supabase.rpc("read_social_token", {
    p_vault_id: row.access_token_vault_id,
  });
  if (readError) throw readError;
  return token as string;
}

/** A paused account (plan downgrade past the tier's connected-account limit —
 *  see ops/accounts/accounts_ops.js's enforceDowngradePause()) keeps its
 *  connection and tokens intact but must never actually post. Checked before
 *  spending a vault read on a token that won't be used. */
async function isAccountPaused(socialAccountId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("social_accounts")
    .select("paused_at")
    .eq("id", socialAccountId)
    .single();
  if (error || !data) throw error ?? new Error("social account not found");
  return data.paused_at !== null;
}

/** Looks up whether this account opted in to failure-alert emails
 *  (project-competitor-feature-audit-2026-08-07.md item 7 — off by
 *  default, see migration 0039_failure_alerts.sql) and fires the right
 *  one if so. Best-effort: a lookup/send problem must never affect the
 *  scheduler's own failure-handling path, same reasoning as notifyOps. */
async function maybeSendFailureAlert(post: DuePost, content: string, reason: string, accountPaused: boolean): Promise<void> {
  try {
    const { data: account } = await supabase
      .from("accounts")
      .select("email, email_failure_alerts_enabled")
      .eq("id", post.account_id)
      .maybeSingle();
    if (!account?.email_failure_alerts_enabled || !account.email) return;
    if (accountPaused) {
      sendAccountPausedAlert(account.email, content);
    } else {
      sendFailureAlert(account.email, content, reason);
    }
  } catch (err) {
    console.error("[scheduler] maybeSendFailureAlert lookup failed:", err instanceof Error ? err.message : err);
  }
}

// Pinterest blocked-link breaker. A blocked link is Pinterest's decision about
// the customer's website address, so a second blocked pin right after a first
// means the rest of their queue is about to fail the same way, each one another
// rejected request that can hurt the account's standing. After this many
// terminal outcomes in a row (posted or failed) for one connected account are
// all blocked-link failures, the account's other pending posts are paused.
const BLOCKED_LINK_STREAK = 2;
const BLOCKED_LINK_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/** Same opt-in toggle and best-effort rules as maybeSendFailureAlert. */
async function maybeSendPinterestPausedAlert(accountId: string): Promise<void> {
  try {
    const { data: account } = await supabase
      .from("accounts")
      .select("email, email_failure_alerts_enabled")
      .eq("id", accountId)
      .maybeSingle();
    if (!account?.email_failure_alerts_enabled || !account.email) return;
    sendPinterestPausedAlert(account.email);
  } catch (err) {
    console.error("[scheduler] maybeSendPinterestPausedAlert lookup failed:", err instanceof Error ? err.message : err);
  }
}

/** Runs after a Pinterest post failed with the blocked-link reason. If this
 *  account's last BLOCKED_LINK_STREAK terminal outcomes (look back 14 days) are
 *  all blocked-link failures, pauses its remaining pending, unpaused posts with
 *  paused_at (the same mechanism as PATCH /scheduled-posts/:id/pause) and tells
 *  the customer once. Nothing is retried, edited, deleted or marked posted. The
 *  pause itself is one conditional UPDATE, so two failures racing each other
 *  pause the posts, and send the email, only once; with nothing pending it does
 *  nothing. Fails safe: any lookup problem is logged and changes nothing. */
async function pauseAfterRepeatedBlockedLinks(post: DuePost): Promise<void> {
  try {
    const since = new Date(Date.now() - BLOCKED_LINK_LOOKBACK_MS).toISOString();
    const { data: recent, error: recentError } = await supabase
      .from("scheduled_posts")
      .select("id")
      .eq("social_account_id", post.social_account_id)
      .in("status", ["posted", "failed"])
      .gt("updated_at", since)
      .order("updated_at", { ascending: false })
      .limit(BLOCKED_LINK_STREAK);
    if (recentError) throw new Error(recentError.message);
    if (!recent || recent.length < BLOCKED_LINK_STREAK) return;

    const { data: results, error: resultsError } = await supabase
      .from("post_results")
      .select("scheduled_post_id, error_message, raw_error_message, created_at")
      .in("scheduled_post_id", recent.map((r) => r.id));
    if (resultsError) throw new Error(resultsError.message);

    const allBlocked = recent.every((r) => {
      // A post's outcome is its newest result row.
      const latest = (results ?? [])
        .filter((x) => x.scheduled_post_id === r.id)
        .sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : -1))[0];
      return !!latest && (latest.error_message === PINTEREST_BLOCKED_LINK_MESSAGE || PINTEREST_BLOCKED_LINK_PATTERN.test(latest.raw_error_message ?? ""));
    });
    if (!allBlocked) return;

    const { data: paused, error: pauseError } = await supabase
      .from("scheduled_posts")
      .update({ paused_at: new Date().toISOString() })
      .eq("social_account_id", post.social_account_id)
      .eq("status", "pending")
      .is("paused_at", null)
      .select("id");
    if (pauseError) throw new Error(pauseError.message);
    if (!paused || paused.length === 0) return;

    console.warn(`Paused ${paused.length} pending Pinterest post(s) for social account ${post.social_account_id}: ${BLOCKED_LINK_STREAK} blocked-link failures in a row.`);
    await maybeSendPinterestPausedAlert(post.account_id);
  } catch (err) {
    console.error("[scheduler] Pinterest blocked-link breaker check failed, nothing changed:", err instanceof Error ? err.message : err);
  }
}

/** Looks up whether this account has a webhook configured (item 5,
 *  2026-08-07 competitor audit — off by default, see migration
 *  0041_webhooks.sql) and fires it if so. Same best-effort reasoning as
 *  maybeSendFailureAlert: a lookup/send problem must never affect the
 *  scheduler's own success path — the post is already live and verified,
 *  which is the promise that matters. */
async function maybeSendWebhook(post: DuePost, platformPostUrl: string | null, verifiedAt: string): Promise<void> {
  await dispatchWebhookEvent({
    accountId: post.account_id,
    event: "post.verified",
    socialAccountId: post.social_account_id,
    data: {
      postId: post.id,
      platform: post.platform,
      socialAccountId: post.social_account_id,
      content: post.content,
      platformPostUrl,
      verifiedAt,
    },
  });
}

/** Tells the customer's webhook endpoints a post did not go out (post.failed) or
 *  went out but could not be confirmed live (post.unconfirmed). Never throws. */
async function emitPostProblem(
  post: { id: string; account_id: string; social_account_id: string; content: string; platform?: string },
  event: "post.failed" | "post.unconfirmed",
  reason: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await dispatchWebhookEvent({
    accountId: post.account_id,
    event,
    socialAccountId: post.social_account_id,
    data: {
      postId: post.id,
      platform: post.platform ?? null,
      socialAccountId: post.social_account_id,
      content: post.content,
      reason,
      ...extra,
    },
  });
}

// Free-tier "Scheduled via LazyRelay" branding, default ON with a
// removable opt-out (accounts.show_branding_tag, migration 0092) -- one of
// two real gaps found auditing a Gemini growth-prompt Werner brought
// 2026-09-28. Paid tiers never see it regardless of the column's value.
const BRANDING_TAG = "— scheduled via LazyRelay (lazyrelay.com)";

// Conservative shared cap for the platforms that get the tag appended to
// their actual caption (see hasCommentChannel below) -- deliberately
// Bluesky's real ~300-character limit, the tightest of the 10 platforms in
// that bucket, so appending the tag can never push ANY of them over their
// own real limit, not just whichever one is being posted to right now.
// Facebook/Instagram use their own much larger MAX_FIRST_COMMENT_LENGTH
// instead, since the tag goes into a first comment there, not the caption.
const BRANDING_TAG_CAPTION_BUDGET = 300;

// Pure decision, kept separate from the DB lookups in resolveBrandingTag
// below purely so it's directly unit-testable without mocking supabase or
// resolveTier -- same "test the logic, not the plumbing" split already used
// for wouldExceedRolling24hLimit in platformPostLimits.ts.
export function shouldShowBrandingTag(tier: Tier, showBrandingTagColumn: boolean | null | undefined): boolean {
  if (tier !== "free") return false;
  // Explicit === false, not just falsy -- an unexpected null/missing value
  // must default to showing the tag (the column's own real default), never
  // to silently suppressing it.
  return showBrandingTagColumn !== false;
}

async function resolveBrandingTag(accountId: string): Promise<string | null> {
  try {
    const [tier, { data: account }] = await Promise.all([
      resolveTier(accountId),
      supabase.from("accounts").select("show_branding_tag").eq("id", accountId).maybeSingle(),
    ]);
    return shouldShowBrandingTag(tier, account?.show_branding_tag) ? BRANDING_TAG : null;
  } catch (err) {
    console.error("[scheduler] resolveBrandingTag lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// Never truncates or displaces the customer's own real content -- if the
// tag doesn't fit within budget alongside what they wrote, the tag is
// dropped silently and their content goes out completely unchanged. A
// missed promotional line is an acceptable cost; a customer's own post
// being cut off or rejected over it is not.
export function appendTagWithinBudget(base: string | null, tag: string, budget: number): string {
  const trimmedBase = (base ?? "").trim();
  if (!trimmedBase) return tag.length <= budget ? tag : "";
  const combined = `${trimmedBase}\n\n${tag}`;
  return combined.length <= budget ? combined : trimmedBase;
}

/** A failure that hasn't exhausted its retries goes back to `pending` with
 *  an exponential backoff delay instead of being marked `failed` outright.
 *  Only once MAX_RETRIES is exhausted does this become a real, alerted
 *  failure — this is what actually backs the Proof-of-Publish promise
 *  against transient errors instead of just the happy path. */
async function handleFailure(post: DuePost, message: string, kind: PostErrorKind = "retry", raw?: string): Promise<void> {
  if (kind === "fatal" || kind === "reconnect") {
    // Retrying cannot help (a blocked link, a duplicate, a bad file, a daily
    // cap, or a dead login), and every retry is another rejected request
    // against the platform. Fail now with the plain-language reason, which the
    // customer sees in their History tab. Real case: 20 Pinterest posts were
    // each retried three times for the same "blocked this link" rejection.
    await supabase.from("scheduled_posts").update({ status: "failed" }).eq("id", post.id);
    console.warn(`Post ${post.id} failed without retrying (${kind}): ${raw ?? message}`);
    if (kind === "reconnect") await flagAccountForReconnect(post, message);
    await maybeSendFailureAlert(post, post.content, message, false);
    await emitPostProblem(post, "post.failed", message, { reasonKind: kind });
    return;
  }
  if (post.retry_count < MAX_RETRIES) {
    const backoffMinutes = BACKOFF_BASE_MINUTES * 2 ** post.retry_count;
    const nextAttempt = new Date(Date.now() + backoffMinutes * 60_000).toISOString();
    await supabase
      .from("scheduled_posts")
      .update({ status: "pending", retry_count: post.retry_count + 1, scheduled_for: nextAttempt })
      .eq("id", post.id);
    console.warn(
      `Post ${post.id} failed (attempt ${post.retry_count + 1}/${MAX_RETRIES + 1}): ${raw ?? message}. Retrying at ${nextAttempt}.`
    );
    return;
  }

  await supabase.from("scheduled_posts").update({ status: "failed" }).eq("id", post.id);
  console.error(`Post ${post.id} permanently failed after ${MAX_RETRIES + 1} attempts: ${raw ?? message}`);
  await notifyOps(`Post ${post.id} permanently failed after ${MAX_RETRIES + 1} attempts: ${raw ?? message}`);
  await maybeSendFailureAlert(post, post.content, message, false);
  // If the platform did accept it, it may well be live: say "unconfirmed", never "failed".
  const accepted = await findAcceptedPublish(post.id);
  if (accepted) {
    await emitPostProblem(post, "post.unconfirmed", message, { platformPostId: accepted.platform_post_id, reasonKind: "retries_exhausted" });
  } else {
    await emitPostProblem(post, "post.failed", message, { reasonKind: "retries_exhausted" });
  }
}

/** Flags the post's connected account as needing a reconnect (once per
 *  problem, see tokenHealth.ts). Best effort: never let this block the
 *  failure handling itself. */
async function flagAccountForReconnect(post: DuePost, reason: string): Promise<void> {
  try {
    const { data: row } = await supabase
      .from("social_accounts")
      .select("id, account_id, platform, display_name, needs_reconnect_at, reconnect_notified_at")
      .eq("id", post.social_account_id)
      .maybeSingle();
    if (row) await flagReconnect(row, reason, { expired: true });
  } catch (err) {
    console.error("[scheduler] could not flag account for reconnect:", err instanceof Error ? err.message : err);
  }
}

/** Records a failed attempt the way every failure path needs: classify the
 *  platform's raw error, keep the raw text for support and show the customer
 *  the plain-language reason (post_results.error_message is what their
 *  History tab displays), count it toward the platform circuit breaker ONLY
 *  when it says something about the platform's health (a customer's blocked
 *  link or a duplicate does not), then hand off to handleFailure. */
async function failAttempt(post: DuePost, platform: string, raw: string): Promise<void> {
  const classified = classifyPostError(platform, raw);
  if (classified.kind === "retry" || classified.kind === "ours") recordFailure(platform);
  await supabase.from("post_results").insert({
    scheduled_post_id: post.id,
    account_id: post.account_id,
    platform_post_id: null,
    platform_post_url: null,
    verified_live: false,
    verification_checked_at: new Date().toISOString(),
    error_message: classified.message,
    // Only set when the message was rewritten; the dashboard uses its presence to
    // know the reason is already plain language (older rows are translated there).
    raw_error_message: classified.message === raw ? null : raw,
  });
  await handleFailure(post, classified.message, classified.kind, raw);
  // After handleFailure, so this post already counts as a failed outcome. Not
  // recordFailure: a customer's blocked link says nothing about Pinterest's health.
  if (platform === "pinterest" && classified.kind === "fatal" && classified.message === PINTEREST_BLOCKED_LINK_MESSAGE) {
    await pauseAfterRepeatedBlockedLinks(post);
  }
}

/** Reverts a claimed post back to pending without counting it as a retry —
 *  used when a post's platform breaker is open, since this isn't a failed
 *  attempt, just a post that hasn't been tried yet this cycle. With
 *  `deferUntil`, also pushes scheduled_for out so it isn't re-claimed until
 *  then (the platform daily-limit backstop below). */
async function unclaimPost(post: DuePost, deferUntil?: Date): Promise<void> {
  await supabase
    .from("scheduled_posts")
    .update(deferUntil ? { status: "pending", scheduled_for: deferUntil.toISOString() } : { status: "pending" })
    .eq("id", post.id);
}

/** Send-time backstop for a platform's rolling-24h posting cap
 *  (platformPostLimits.ts -- today only Pinterest). The real enforcement is
 *  at scheduling time; this only catches what got past it (posts scheduled
 *  before the cap existed, a race between two simultaneous requests, or a
 *  retry landing on top of a full day). Returns when this post can next go
 *  out if the account already has `limit` or more posted/posting posts in
 *  the last 24h, or null when it's fine to send. The post itself is
 *  excluded -- it's already 'posting' from the claim. Other posts claimed in
 *  the same cycle count, which can only over-defer, never over-send.
 *
 *  Fails open (null): a failed lookup must not turn into a post failure,
 *  and the scheduling-time check already ran. */
export async function getPlatformLimitDeferral(post: DuePost): Promise<Date | null> {
  if (getRolling24hPostLimit(post.platform) === null) return null;
  try {
    const now = new Date();
    // A brand-new Pinterest account is on the warm-up ramp (pinterestWarmup.ts).
    const effective = await resolvePostLimitAt(post.social_account_id, post.platform, now);
    if (!effective) return null;
    const limit = effective.limit;
    const { data, error } = await supabase
      .from("scheduled_posts")
      .select("scheduled_for")
      .eq("social_account_id", post.social_account_id)
      .in("status", ["posted", "posting"])
      .is("paused_at", null)
      .neq("id", post.id)
      .gt("scheduled_for", new Date(now.getTime() - ROLLING_WINDOW_MS).toISOString())
      .lte("scheduled_for", now.toISOString());
    if (error) throw error;
    const recent = (data ?? []).map((r) => new Date(r.scheduled_for as string));
    if (!wouldExceedRolling24hLimit(recent, now, limit)) return null;
    return nextAllowedTime(recent, now, limit);
  } catch (err) {
    console.warn(
      `[scheduler] couldn't check the ${post.platform} daily posting limit for post ${post.id}, sending anyway:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** The result row of an earlier attempt for this post where the platform
 *  accepted it (it handed back a post id), or null if none did. Its
 *  existence means the content is probably already public, so a retry must
 *  re-verify it and never call adapter.post() again. */
export async function findAcceptedPublish(postId: string): Promise<{ id: string; platform_post_id: string } | null> {
  const { data } = await supabase
    .from("post_results")
    .select("id, platform_post_id")
    .eq("scheduled_post_id", postId)
    .not("platform_post_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  return row?.platform_post_id ? { id: row.id, platform_post_id: row.platform_post_id } : null;
}

// A post normally leaves "posting" within seconds; the slowest legitimate
// path (a large video upload plus verification polling) is a few minutes.
// Anything older than this was stranded by a crash or restart mid-publish.
const STUCK_POSTING_MINUTES = 20;
// Throttle so the sweep costs one cheap query a minute, not one per cycle.
const STUCK_SWEEP_INTERVAL_MS = 60_000;
let lastStuckSweepAt = 0;

/** Rescues posts stranded in "posting" (claimDuePosts flips a post to
 *  "posting" and only processPost moves it on, so a crash or Render restart
 *  in between left it there forever, invisible to every later cycle and
 *  never surfaced to the customer).
 *   - The platform already returned a post id: send it back to pending; the
 *     next cycle re-verifies it without publishing again.
 *   - No post id: we can't know whether the platform published it before the
 *     process died, and re-posting could duplicate it. So it is failed with
 *     an honest "unconfirmed, check your account" reason and alerted, never
 *     silently retried. */
export async function recoverStuckPosts(now: number = Date.now()): Promise<number> {
  if (now - lastStuckSweepAt < STUCK_SWEEP_INTERVAL_MS) return 0;
  lastStuckSweepAt = now;
  const cutoff = new Date(now - STUCK_POSTING_MINUTES * 60_000).toISOString();
  const { data: stuck, error } = await supabase
    .from("scheduled_posts")
    .select("id, account_id, social_account_id, content, retry_count, social_accounts(platform)")
    .eq("status", "posting")
    .lt("updated_at", cutoff)
    .limit(50);
  if (error) {
    console.error("[scheduler] stuck-post sweep failed:", error.message);
    return 0;
  }
  let recovered = 0;
  for (const row of stuck ?? []) {
    const accepted = await findAcceptedPublish(row.id);
    if (accepted) {
      // Guarded on status so a post that finished on its own in the meantime
      // is not touched.
      const { data: reset } = await supabase
        .from("scheduled_posts")
        .update({ status: "pending" })
        .eq("id", row.id)
        .eq("status", "posting")
        .select("id");
      if (reset && reset.length > 0) {
        recovered += 1;
        console.warn(`Post ${row.id} was stuck in "posting" with platform post ${accepted.platform_post_id} -- returned to pending to re-verify.`);
      }
      continue;
    }
    const message =
      "Publishing was interrupted before LazyRelay could confirm the result. It may or may not have gone live, so it was not retried automatically. Check your account before posting again.";
    const { data: failed } = await supabase
      .from("scheduled_posts")
      .update({ status: "failed" })
      .eq("id", row.id)
      .eq("status", "posting")
      .select("id");
    if (!failed || failed.length === 0) continue;
    recovered += 1;
    await supabase.from("post_results").insert({
      scheduled_post_id: row.id,
      account_id: row.account_id,
      platform_post_id: null,
      platform_post_url: null,
      verified_live: false,
      verification_checked_at: new Date().toISOString(),
      error_message: message,
    });
    console.error(`Post ${row.id} was stuck in "posting" for over ${STUCK_POSTING_MINUTES} minutes with no platform post id -- marked failed (unconfirmed).`);
    await notifyOps(`Post ${row.id} was stuck in "posting" for over ${STUCK_POSTING_MINUTES} minutes (likely a restart mid-publish) and was marked failed as unconfirmed. Check the platform for a live copy before anyone re-posts it.`);
    await maybeSendFailureAlert(row as unknown as DuePost, row.content, message, false);
    const stuckAccount = Array.isArray(row.social_accounts) ? row.social_accounts[0] : row.social_accounts;
    await emitPostProblem({ ...row, platform: (stuckAccount as { platform?: string } | null)?.platform }, "post.unconfirmed", message, { reasonKind: "interrupted" });
  }
  return recovered;
}

/** When this post's delayed first comment is due (now + the customer's chosen delay), or null for "right away".
 *  Any trouble reading the column (including it not existing yet) means "right away", the behaviour before delays. */
async function lookupFirstCommentDueAt(postId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.from("scheduled_posts").select("first_comment_delay_minutes").eq("id", postId).single();
    if (error || !data) return null;
    return firstCommentDueAt((data as { first_comment_delay_minutes: number | null }).first_comment_delay_minutes, Date.now());
  } catch {
    return null;
  }
}

// A claimed comment with no outcome after this long was stranded by a crash or restart mid-send.
const STUCK_FIRST_COMMENT_MINUTES = 20;
const FIRST_COMMENT_BATCH_SIZE = 20;

interface FirstCommentRow {
  id: string;
  scheduled_post_id: string;
  platform_post_id: string | null;
  verified_live: boolean | null;
  first_comment_due_at: string;
}

/** Posts the delayed first comments whose time has come. Safe to call from every
 *  scheduler cycle and from several workers at once:
 *   - a comment is CLAIMED (first_comment_claimed_at set) by an update that only succeeds
 *     while it is still unclaimed, and only the caller that gets the row back posts it, so a
 *     second worker or a restart can never comment twice;
 *   - once claimed it is never retried (a send that timed out may still have landed); the
 *     outcome is recorded either way, like the immediate comment;
 *   - a comment more than 24 hours past due is marked failed, not posted;
 *   - a post that is not live any more never gets its comment;
 *   - a comment held up because the platform is not configured, its breaker is open or the
 *     account is paused is released, so a later pass picks it up (until it goes stale).
 *  Returns how many comments were actually sent. */
export async function runFirstCommentPass(registry: PlatformAdapterRegistry, now: number = Date.now()): Promise<number> {
  const nowIso = new Date(now).toISOString();

  // A claim that never got an outcome (the process died mid-send): we cannot know whether it posted.
  const stuckCutoff = new Date(now - STUCK_FIRST_COMMENT_MINUTES * 60_000).toISOString();
  const { data: stuck } = await supabase
    .from("post_results")
    .select("id")
    .is("first_comment_posted", null)
    .not("first_comment_claimed_at", "is", null)
    .lt("first_comment_claimed_at", stuckCutoff)
    .limit(FIRST_COMMENT_BATCH_SIZE);
  for (const row of stuck ?? []) {
    await supabase
      .from("post_results")
      .update({
        first_comment_posted: false,
        first_comment_error: "Posting the comment was interrupted before LazyRelay could confirm it. It may or may not be on your post, so it was not retried.",
      })
      .eq("id", row.id)
      .is("first_comment_posted", null);
  }

  const { data: waiting, error: waitingError } = await supabase
    .from("post_results")
    .select("id")
    .is("first_comment_posted", null)
    .is("first_comment_claimed_at", null)
    .not("first_comment_due_at", "is", null)
    .lte("first_comment_due_at", nowIso)
    .limit(FIRST_COMMENT_BATCH_SIZE);
  if (waitingError) throw waitingError;
  if (!waiting || waiting.length === 0) return 0;

  // As in claimDuePosts: only the rows this UPDATE hands back are ours.
  const { data: claimed, error: claimError } = await supabase
    .from("post_results")
    .update({ first_comment_claimed_at: nowIso })
    .in("id", waiting.map((r) => r.id))
    .is("first_comment_claimed_at", null)
    .is("first_comment_posted", null)
    .select("id, scheduled_post_id, platform_post_id, verified_live, first_comment_due_at");
  if (claimError) throw claimError;

  let sent = 0;
  for (const row of (claimed ?? []) as FirstCommentRow[]) {
    try {
      if (await processFirstComment(row, registry, now)) sent += 1;
    } catch (err) {
      // Unexpected: record it so the claim is never left dangling and nothing retries it blindly.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] first comment for result ${row.id} threw:`, message);
      await finishFirstComment(row.id, false, message);
    }
  }
  return sent;
}

async function finishFirstComment(resultId: string, posted: boolean, error: string | null): Promise<void> {
  await supabase.from("post_results").update({ first_comment_posted: posted, first_comment_error: error }).eq("id", resultId);
}

async function releaseFirstComment(resultId: string): Promise<void> {
  await supabase.from("post_results").update({ first_comment_claimed_at: null }).eq("id", resultId).is("first_comment_posted", null);
}

/** Handles one claimed comment. Returns true when a send was actually attempted. */
async function processFirstComment(row: FirstCommentRow, registry: PlatformAdapterRegistry, now: number): Promise<boolean> {
  const decision = decideFirstComment(row.first_comment_due_at, now);
  if (decision === "stale") {
    await finishFirstComment(row.id, false, "The comment was more than 24 hours late (LazyRelay could not post it in time), so it was not posted.");
    return false;
  }
  if (decision === "wait") {
    await releaseFirstComment(row.id);
    return false;
  }

  const { data: post } = await supabase
    .from("scheduled_posts")
    .select("id, account_id, social_account_id, first_comment, status, social_accounts(platform)")
    .eq("id", row.scheduled_post_id)
    .maybeSingle();
  const p = post as { id: string; account_id: string; social_account_id: string; first_comment: string | null; status: string; social_accounts: unknown } | null;
  if (!p || p.status !== "posted" || !row.verified_live || !row.platform_post_id) {
    await finishFirstComment(row.id, false, "The post is no longer live, so the comment was not posted.");
    return false;
  }
  if (!p.first_comment || !p.first_comment.trim()) {
    await finishFirstComment(row.id, false, "The post no longer has a first comment, so nothing was posted.");
    return false;
  }
  const sa = Array.isArray(p.social_accounts) ? p.social_accounts[0] : p.social_accounts;
  const platform = (sa as { platform?: string } | null)?.platform ?? "";
  const adapter = registry.get(platform);
  if (!adapter || !adapter.postComment) {
    // Platform not configured on this deploy: nothing was sent, so release it for a later pass.
    await releaseFirstComment(row.id);
    return false;
  }
  if (isBreakerTripped(platform) || (await isAccountPaused(p.social_account_id))) {
    await releaseFirstComment(row.id);
    return false;
  }

  const brandingTag = await resolveBrandingTag(p.account_id);
  const text = brandingTag ? appendTagWithinBudget(p.first_comment, brandingTag, MAX_FIRST_COMMENT_LENGTH) : p.first_comment;
  try {
    const accessToken = await getAccessToken(p.social_account_id, adapter);
    const result = await adapter.postComment(row.platform_post_id, text, accessToken);
    await finishFirstComment(row.id, result.success, result.success ? null : result.errorMessage);
    if (!result.success) console.warn(`Post ${p.id}: delayed first comment failed: ${result.errorMessage}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishFirstComment(row.id, false, classifyPostError(platform, message).message);
    console.warn(`Post ${p.id}: delayed first comment threw: ${message}`);
  }
  return true;
}

async function processPost(post: DuePost, registry: PlatformAdapterRegistry): Promise<void> {
  const adapter = registry.get(post.platform);
  if (!adapter) {
    // Platform isn't configured on this deploy (env vars missing) — not a
    // post/adapter failure, so this doesn't count against retries either;
    // just leave it pending for the next cycle once the platform is live.
    // claimDuePosts() already flipped this post to "posting" before we ever
    // got here — without this un-claim, it would sit stuck on "posting"
    // forever, invisible to every future cycle's `.eq("status","pending")`
    // claim query, silently never posting and never surfacing an error.
    console.warn(`Post ${post.id} left pending — no adapter configured for platform "${post.platform}".`);
    await unclaimPost(post);
    return;
  }
  try {
    if (await isAccountPaused(post.social_account_id)) {
      // Not a platform/adapter failure — retrying won't help until the
      // account is unpaused, so this skips handleFailure's backoff-retry
      // path and the circuit breaker entirely, and fails immediately with
      // a reason the customer can act on (upgrade or reconnect).
      await supabase.from("scheduled_posts").update({ status: "failed" }).eq("id", post.id);
      console.warn(`Post ${post.id} failed: connected account is paused (plan downgrade).`);
      await notifyOps(`Post ${post.id} failed: social account ${post.social_account_id} is paused (plan downgrade past connected-account limit).`);
      await maybeSendFailureAlert(post, post.content, "connected account is paused", true);
      await emitPostProblem(post, "post.failed", "The connected account is paused (a plan downgrade or a disconnected account).", { reasonKind: "account_paused" });
      return;
    }

    // Platform daily-limit backstop. Not a failure of any kind, so it skips
    // handleFailure's retry count, the post_results row and the circuit
    // breaker entirely -- the post just goes back to pending, pushed out to
    // when the window frees up, via the same un-claim the breaker uses.
    const deferUntil = await getPlatformLimitDeferral(post);
    if (deferUntil) {
      console.warn(
        `Deferring post ${post.id} to ${deferUntil.toISOString()} — social account ${post.social_account_id} is at its ${post.platform} posting limit for the last 24 hours.`,
      );
      await unclaimPost(post, deferUntil);
      return;
    }

    const accessToken = await getAccessToken(post.social_account_id, adapter);

    // Platforms with a real first-comment channel (adapter.postComment,
    // currently Facebook/Instagram only) keep their own caption untouched
    // -- the tag goes into the comment instead, below, once the post is
    // verified live. Every other platform has no separate comment channel
    // to use, so the tag is appended to the caption itself when it fits.
    const brandingTag = await resolveBrandingTag(post.account_id);
    const hasCommentChannel = !!adapter.postComment;
    const outgoingContent =
      !hasCommentChannel && brandingTag ? appendTagWithinBudget(post.content, brandingTag, BRANDING_TAG_CAPTION_BUDGET) : post.content;

    // A previous attempt already got a platform post id back (the platform
    // accepted the post) but verification couldn't confirm it live, so the
    // row was reset to pending. Calling post() again would publish a SECOND
    // copy of something that is probably already public -- the cause of the
    // duplicate Facebook/Reel/Telegram posts logged in the platform
    // capability matrix. Re-check the existing post instead.
    const alreadyPublished = await findAcceptedPublish(post.id);
    const attempt: PostAttemptResult = alreadyPublished
      ? { success: true, platformPostId: alreadyPublished.platform_post_id, errorMessage: null }
      : await adapter.post({
          socialAccountId: post.social_account_id,
          platformAccountId: post.platform_account_id ?? null,
          content: outgoingContent,
          mediaUrl: post.media_url,
          mediaUrls: post.media_urls ?? [],
          options: post.options ?? {},
          coverImageUrl: post.cover_image_url,
          boardId: post.board_id,
          destinationLink: post.destination_link,
          mediaAltText: post.media_alt_text,
          tiktokPrivacyLevel: post.tiktok_privacy_level,
          tiktokDisableComment: post.tiktok_disable_comment,
          tiktokDisableDuet: post.tiktok_disable_duet,
          tiktokDisableStitch: post.tiktok_disable_stitch,
          tiktokBrandOrganic: post.tiktok_brand_organic,
          tiktokBrandContent: post.tiktok_brand_content,
          scheduledPostId: post.id,
          accessToken,
        });
    if (alreadyPublished) {
      console.warn(`Post ${post.id}: platform post ${alreadyPublished.platform_post_id} already exists -- re-verifying it, not publishing again.`);
    }

    if (!attempt.success || !attempt.platformPostId) {
      // Persisted (with a plain-language reason) so a pre-verification failure
      // (bad media, missing scope, no board, etc.) shows a real reason in the
      // customer's History tab instead of a bare "failed" badge.
      await failAttempt(post, adapter.platform, attempt.errorMessage ?? "post attempt failed, no reason given");
      return;
    }

    // The post API call succeeding is NOT the same as the content being
    // live — this read-back check is the actual Proof-of-Publish
    // differentiator, not an optional extra step.
    const verification = await adapter.verifyPublished(attempt.platformPostId, accessToken);

    // The customer chose to save this as a DRAFT on the platform (WordPress, dev.to, Hashnode). It exists there
    // and is not public, so it can never be verified live: that is a finished job, not a failure. Record it as
    // such and stop, with no retry (a retry would only re-check the same draft) and no first comment or thread.
    if (verification.savedAsDraft) {
      const draftFields = {
        platform_post_url: verification.platformPostUrl,
        verified_live: false,
        saved_as_draft: true,
        verification_checked_at: new Date().toISOString(),
        error_message: verification.errorMessage,
        raw_error_message: null,
      };
      if (alreadyPublished) {
        await supabase.from("post_results").update(draftFields).eq("id", alreadyPublished.id);
      } else {
        await supabase.from("post_results").insert({ scheduled_post_id: post.id, account_id: post.account_id, platform_post_id: attempt.platformPostId, ...draftFields });
      }
      recordSuccess(adapter.platform);
      await supabase.from("scheduled_posts").update({ status: "posted" }).eq("id", post.id);
      return;
    }

    // first_comment_posted/first_comment_error start null here (not yet
    // attempted) and are filled in below, only once the parent post is
    // confirmed live — a comment on a post that isn't verified would be
    // commenting on something LazyRelay can't actually vouch for yet.
    const verifiedAt = new Date().toISOString();
    const rawVerifyError = verification.errorMessage ?? "post published but verification could not confirm it went live";
    const verifyFailure = verification.verifiedLive ? null : classifyPostError(adapter.platform, rawVerifyError);
    const resultFields = {
      platform_post_url: verification.platformPostUrl,
      verified_live: verification.verifiedLive,
      verification_checked_at: verifiedAt,
      error_message: verifyFailure ? verifyFailure.message : verification.errorMessage,
      raw_error_message: verifyFailure && verifyFailure.message !== rawVerifyError ? rawVerifyError : null,
    };
    // A re-verify updates the row the first attempt wrote (one result per
    // post, and its id is the public proof link) rather than adding a second.
    const { data: resultRow } = alreadyPublished
      ? await supabase.from("post_results").update(resultFields).eq("id", alreadyPublished.id).select("id").single()
      : await supabase
          .from("post_results")
          .insert({
            scheduled_post_id: post.id,
            account_id: post.account_id,
            platform_post_id: attempt.platformPostId,
            ...resultFields,
          })
          .select("id")
          .single();

    if (verifyFailure) {
      if (verifyFailure.kind === "retry" || verifyFailure.kind === "ours") recordFailure(adapter.platform);
      await handleFailure(post, verifyFailure.message, verifyFailure.kind, rawVerifyError);
      return;
    }

    recordSuccess(adapter.platform);
    await supabase.from("scheduled_posts").update({ status: "posted" }).eq("id", post.id);
    await maybeSendWebhook(post, verification.platformPostUrl, verifiedAt);

    // Best-effort, non-fatal: a comment failure must never flip the parent
    // post's own status or trigger handleFailure's retry path — the post
    // itself is already live and verified, which is the promise that
    // matters. Only attempted for platforms that declare postComment (see
    // PlatformAdapter.postComment) and only when there's something to post
    // -- the customer's own first comment, the branding tag appended after
    // it, or the tag standing alone if they didn't set one.
    const effectiveFirstComment = hasCommentChannel && brandingTag ? appendTagWithinBudget(post.first_comment, brandingTag, MAX_FIRST_COMMENT_LENGTH) : post.first_comment;
    if (effectiveFirstComment && adapter.postComment && resultRow) {
      // A customer can hold the comment back (first_comment_delay_minutes). Looked up here, only for a post that
      // has a comment, and not in the claim query, so a database without the column (migration not applied yet)
      // just behaves as "right away", exactly as before, and can never stop a post publishing.
      const dueAt = await lookupFirstCommentDueAt(post.id);
      if (dueAt) {
        // Not posted now: runFirstCommentPass posts it once it is due.
        const { error: dueError } = await supabase.from("post_results").update({ first_comment_due_at: dueAt }).eq("id", resultRow.id);
        if (dueError) {
          await supabase
            .from("post_results")
            .update({ first_comment_posted: false, first_comment_error: "The comment could not be scheduled for later, so it was not posted." })
            .eq("id", resultRow.id);
          console.warn(`Post ${post.id}: could not schedule the delayed first comment -- ${dueError.message}`);
        }
      } else {
        try {
          const commentResult = await adapter.postComment(attempt.platformPostId, effectiveFirstComment, accessToken);
          await supabase
            .from("post_results")
            .update({
              first_comment_posted: commentResult.success,
              first_comment_error: commentResult.errorMessage,
            })
            .eq("id", resultRow.id);
          if (!commentResult.success) {
            console.warn(`Post ${post.id}: first comment failed — ${commentResult.errorMessage}`);
          }
        } catch (commentErr) {
          const commentErrorMessage = commentErr instanceof Error ? commentErr.message : String(commentErr);
          await supabase
            .from("post_results")
            .update({ first_comment_posted: false, first_comment_error: commentErrorMessage })
            .eq("id", resultRow.id);
          console.warn(`Post ${post.id}: first comment threw — ${commentErrorMessage}`);
        }
      }
    }

    // Thread chain (master list #20): best effort like the first comment, run once,
    // only after the main post is live and verified. See chainRunner.ts.
    const chainTexts = post.options?.chain ?? [];
    if (chainTexts.length > 0 && adapter.postChainReply && resultRow) {
      const outcome = await runChain(adapter, { rootPostId: attempt.platformPostId as string, texts: chainTexts, accessToken, platformAccountId: post.platform_account_id ?? null });
      await supabase.from("post_results").update({ chain_posted: outcome.posted, chain_error: outcome.error }).eq("id", resultRow.id);
      if (outcome.error) console.warn(`Post ${post.id}: thread stopped after ${outcome.posted} follow-up(s) — ${outcome.error}`);
    }
  } catch (err) {
    // Same reasoning as the post()-failure branch above — an unexpected
    // throw (network error, malformed adapter response, etc.) previously
    // vanished into console/Slack with nothing in the customer-visible
    // History tab.
    await failAttempt(post, adapter.platform, err instanceof Error ? err.message : String(err));
  }
}

/** One poll cycle: claim whatever's due across ALL platforms, process each
 *  post against its own platform's adapter. Call this on an interval (or
 *  from a cron trigger) — it does not loop internally. A single tripped
 *  breaker no longer skips the whole cycle (that only made sense back when
 *  one cycle meant one platform) — instead, any post whose platform's
 *  breaker is open gets un-claimed (back to pending, no retry-count hit)
 *  and the rest of the batch keeps going.
 *
 *  Posts are processed concurrently, not one-at-a-time — the batch used to
 *  serialize on `await processPost(...)`, so a slow platform call held up
 *  every other post behind it even though they're independent network
 *  calls to different customers/platforms. The breaker/rate-limit checks
 *  themselves stay synchronous (no `await` before they touch their Maps),
 *  so `due.map`'s synchronous run-up still performs every post's check in
 *  original claim order before any post's actual network call starts —
 *  same admission behavior as before, just concurrent execution after. */
export async function runSchedulerCycle(registry: PlatformAdapterRegistry): Promise<void> {
  try {
    await recoverStuckPosts();
  } catch (err) {
    // The sweep is a safety net; it must never stop today's posts going out.
    console.error("[scheduler] recoverStuckPosts threw:", err instanceof Error ? err.message : err);
  }
  const due = await claimDuePosts();
  if (due.length === 0) {
    await runFirstCommentPassSafely(registry);
    return;
  }

  console.log(`Claimed ${due.length} due post(s).`);
  await Promise.all(
    due.map(async (post) => {
      if (isBreakerTripped(post.platform)) {
        console.warn(`Un-claiming post ${post.id} — circuit breaker open for platform "${post.platform}".`);
        await unclaimPost(post);
        return;
      }
      if (isRateLimited(post.platform)) {
        console.warn(`Un-claiming post ${post.id} — proactive rate limit reached for platform "${post.platform}" this window.`);
        await unclaimPost(post);
        return;
      }
      await processPost(post, registry);
    })
  );
  await runFirstCommentPassSafely(registry);
}

/** Delayed first comments run after the cycle's posts, and a problem here never stops the next cycle's posts. */
async function runFirstCommentPassSafely(registry: PlatformAdapterRegistry): Promise<void> {
  try {
    await runFirstCommentPass(registry);
  } catch (err) {
    console.error("[scheduler] delayed first comment pass threw:", err instanceof Error ? err.message : err);
  }
}
