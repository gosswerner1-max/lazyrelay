import { supabase } from "./supabase.js";
import type { PlatformAdapterRegistry } from "./platforms/connect.js";
import type { PlatformAdapter, PostAttemptResult } from "./platforms/types.js";
import { notifyOps } from "./notify.js";
import { clearReconnect, flagReconnect, isPermanentAuthError, platformLabel } from "./tokenHealth.js";
import { sendFailureAlert, sendAccountPausedAlert } from "./email.js";
import { sendVerifiedWebhook } from "./webhook.js";
import {
  ROLLING_WINDOW_MS,
  getRolling24hPostLimit,
  nextAllowedTime,
  wouldExceedRolling24hLimit,
} from "./platformPostLimits.js";
import { resolveTier, type Tier } from "./tier.js";
import { MAX_FIRST_COMMENT_LENGTH } from "./postCreation.js";

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
      "id, account_id, social_account_id, content, media_url, cover_image_url, board_id, destination_link, first_comment, media_alt_text, tiktok_privacy_level, tiktok_disable_comment, tiktok_disable_duet, tiktok_disable_stitch, tiktok_brand_organic, tiktok_brand_content, retry_count, social_accounts(platform)",
    );

  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) return [];

  return claimed.map((p) => {
    // Supabase's PostgREST client types a to-one embed as an array even
    // though the FK guarantees exactly one row here.
    const account = Array.isArray(p.social_accounts) ? p.social_accounts[0] : p.social_accounts;
    const { social_accounts: _social_accounts, ...rest } = p as typeof p & { social_accounts: unknown };
    return { ...rest, platform: account?.platform } as DuePost;
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

/** Looks up whether this account has a webhook configured (item 5,
 *  2026-08-07 competitor audit — off by default, see migration
 *  0041_webhooks.sql) and fires it if so. Same best-effort reasoning as
 *  maybeSendFailureAlert: a lookup/send problem must never affect the
 *  scheduler's own success path — the post is already live and verified,
 *  which is the promise that matters. */
async function maybeSendWebhook(post: DuePost, platformPostUrl: string | null, verifiedAt: string): Promise<void> {
  try {
    const { data: account } = await supabase
      .from("accounts")
      .select("webhook_url, webhook_secret")
      .eq("id", post.account_id)
      .maybeSingle();
    if (!account?.webhook_url || !account.webhook_secret) return;
    sendVerifiedWebhook(account.webhook_url, account.webhook_secret, {
      postId: post.id,
      platform: post.platform,
      content: post.content,
      platformPostUrl,
      verifiedAt,
    });
  } catch (err) {
    console.error("[scheduler] maybeSendWebhook lookup failed:", err instanceof Error ? err.message : err);
  }
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
  await maybeSendFailureAlert(post, post.content, message, false);
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
  const limit = getRolling24hPostLimit(post.platform);
  if (limit === null) return null;
  try {
    const now = new Date();
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
    .select("id, account_id, social_account_id, content, retry_count")
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
    await maybeSendFailureAlert(row as DuePost, row.content, message, false);
  }
  return recovered;
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
          content: outgoingContent,
          mediaUrl: post.media_url,
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
          accessToken,
        });
    if (alreadyPublished) {
      console.warn(`Post ${post.id}: platform post ${alreadyPublished.platform_post_id} already exists -- re-verifying it, not publishing again.`);
    }

    if (!attempt.success || !attempt.platformPostId) {
      recordFailure(adapter.platform);
      // Persisted the same way a verification failure is below, so a
      // pre-verification failure (bad media, missing scope, no board, etc.)
      // shows a real reason in the customer's History tab instead of just
      // a bare "failed" badge with nothing explaining why — this was a real
      // gap: every prior failure here only reached console/Slack, never the
      // database, so a customer who wasn't watching Render logs had no way
      // to see why their own post never went out.
      const errorMessage = attempt.errorMessage ?? "post attempt failed, no reason given";
      await supabase.from("post_results").insert({
        scheduled_post_id: post.id,
        account_id: post.account_id,
        platform_post_id: null,
        platform_post_url: null,
        verified_live: false,
        verification_checked_at: new Date().toISOString(),
        error_message: errorMessage,
      });
      await handleFailure(post, errorMessage);
      return;
    }

    // The post API call succeeding is NOT the same as the content being
    // live — this read-back check is the actual Proof-of-Publish
    // differentiator, not an optional extra step.
    const verification = await adapter.verifyPublished(attempt.platformPostId, accessToken);

    // first_comment_posted/first_comment_error start null here (not yet
    // attempted) and are filled in below, only once the parent post is
    // confirmed live — a comment on a post that isn't verified would be
    // commenting on something LazyRelay can't actually vouch for yet.
    const verifiedAt = new Date().toISOString();
    const resultFields = {
      platform_post_url: verification.platformPostUrl,
      verified_live: verification.verifiedLive,
      verification_checked_at: verifiedAt,
      error_message: verification.errorMessage,
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

    if (!verification.verifiedLive) {
      recordFailure(adapter.platform);
      await handleFailure(post, verification.errorMessage ?? "post published but verification could not confirm it went live");
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
  } catch (err) {
    recordFailure(adapter.platform);
    // Same reasoning as the post()-failure branch above — an unexpected
    // throw (network error, malformed adapter response, etc.) previously
    // vanished into console/Slack with nothing in the customer-visible
    // History tab.
    const errorMessage = err instanceof Error ? err.message : String(err);
    await supabase.from("post_results").insert({
      scheduled_post_id: post.id,
      account_id: post.account_id,
      platform_post_id: null,
      platform_post_url: null,
      verified_live: false,
      verification_checked_at: new Date().toISOString(),
      error_message: errorMessage,
    });
    await handleFailure(post, errorMessage);
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
  if (due.length === 0) return;

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
}
