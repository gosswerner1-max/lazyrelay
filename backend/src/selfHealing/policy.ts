// The self-healing retry policy. Pure: no I/O, and the clock and the random source are passed in, so the same input always gives
// the same answer. The scheduler calls it only when SELF_HEALING_MODE is on (decides) or shadow (evaluated and recorded, never acted on).

export type ErrorClass = "transient" | "rate_limited" | "auth" | "fatal" | "ambiguous";

export type ReasonCode = "retries_exhausted" | "too_late" | "fatal" | "auth_rejected";

export type Decision =
  | { action: "retry"; delayMs: number; runAt: number; baseDelayMs: number; refreshFirst?: boolean }
  | { action: "reverify"; delayMs: number; runAt: number; baseDelayMs: number }
  | { action: "fail"; reason: ReasonCode; message: string }
  | { action: "hold_connection"; reason: "auth_rejected"; message: string };

export interface RetryInput {
  errorClass: ErrorClass;
  platform: string;
  /** Failed attempts before this one (scheduled_posts.retry_count). */
  retryCount: number;
  now: number;
  random: () => number;
  /** When the post was due, ms since epoch; null when unknown. */
  scheduledFor: number | null;
  /** The earliest time the platform said it will accept another try, ms since epoch. */
  platformWaitUntil?: number;
  /** The plain sentence the customer sees for this failure. */
  message: string;
  auth?: { canRefresh: boolean; refreshTried: boolean };
}

const MIN = 60_000;

/** The four retries, in order. A fifth failure is terminal. */
export const TRANSIENT_RETRY_BASE_MS: readonly number[] = [2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN];
export const MAX_RETRIES = TRANSIENT_RETRY_BASE_MS.length;

const JITTER_MIN = 0.8;
const JITTER_SPAN = 0.4;

const MAX_PLATFORM_WAIT_MS = 20 * MIN;
const MAX_WHATSAPP_WAIT_MS = 25 * 60 * MIN;

/** A post is never published more than this long after its time (WhatsApp has its own 25 hour cap and is exempt). */
export const FRESHNESS_LIMIT_MS = 2 * 60 * MIN;
export const TOO_LATE_MESSAGE = "This post was not sent because it was more than 2 hours past its time. Reschedule it if you still want it out.";

const tooLate = (): Decision => ({ action: "fail", reason: "too_late", message: TOO_LATE_MESSAGE });

/** Claim-time freshness. Returns the too_late failure, or null when the post may go ahead. */
export function checkFreshness(args: { platform: string; scheduledFor: number | null; now: number }): Decision | null {
  if (args.platform === "whatsapp" || args.scheduledFor === null) return null;
  return args.now - args.scheduledFor > FRESHNESS_LIMIT_MS ? tooLate() : null;
}

export function decideRetry(input: RetryInput): Decision {
  const { errorClass, retryCount, now } = input;

  if (errorClass === "fatal") return { action: "fail", reason: "fatal", message: input.message };

  if (errorClass === "auth") {
    const auth = input.auth ?? { canRefresh: false, refreshTried: false };
    if (auth.canRefresh && !auth.refreshTried) {
      const late = checkFreshness({ platform: input.platform, scheduledFor: input.scheduledFor, now });
      return late ?? { action: "retry", delayMs: 0, runAt: now, baseDelayMs: 0, refreshFirst: true };
    }
    return { action: "hold_connection", reason: "auth_rejected", message: input.message };
  }

  if (retryCount >= MAX_RETRIES) return { action: "fail", reason: "retries_exhausted", message: input.message };

  const jitter = JITTER_MIN + JITTER_SPAN * input.random();
  const scheduleBase = TRANSIENT_RETRY_BASE_MS[retryCount];
  const jittered = Math.round(scheduleBase * jitter);

  if (errorClass === "ambiguous") {
    // The platform may already have the post: only ever re-check it, never publish again, and never fail it as too late.
    return { action: "reverify", delayMs: jittered, runAt: now + jittered, baseDelayMs: scheduleBase };
  }

  let delayMs = jittered;
  let baseDelayMs = scheduleBase;
  if (errorClass === "rate_limited" && input.platformWaitUntil !== undefined) {
    const cap = input.platform === "whatsapp" ? MAX_WHATSAPP_WAIT_MS : MAX_PLATFORM_WAIT_MS;
    const wait = Math.min(Math.max(input.platformWaitUntil - now, 0), cap);
    delayMs = Math.max(jittered, wait);
    baseDelayMs = Math.max(scheduleBase, wait);
  }
  const runAt = now + delayMs;
  const late = checkFreshness({ platform: input.platform, scheduledFor: input.scheduledFor, now: runAt });
  return late ?? { action: "retry", delayMs, runAt, baseDelayMs };
}

// ---- Circuit breaker with a half-open probe -------------------------------------------------------------------------------
// closed -> (threshold failures in a row) -> open for the cooldown -> half-open: exactly ONE attempt is let through. A success
// closes the breaker and resets the cooldown; a failure re-opens it with the cooldown doubled, capped at 60 minutes.

export interface BreakerConfig {
  threshold: number;
  baseCooldownMs: number;
}
export const SHARED_BREAKER: BreakerConfig = { threshold: 5, baseCooldownMs: 5 * MIN };
export const CUSTOMER_KEY_BREAKER: BreakerConfig = { threshold: 3, baseCooldownMs: 15 * MIN };
export const MAX_BREAKER_COOLDOWN_MS = 60 * MIN;
/** A probe that has not reported back after this long is given up on, so a lost attempt cannot hold a platform shut for ever. */
export const PROBE_TIMEOUT_MS = 10 * MIN;

export interface HealingBreaker {
  consecutiveFailures: number;
  /** Null while closed. While set, the breaker is open until then and half-open after. */
  trippedUntil: number | null;
  cooldownMs: number;
  /** When the one half-open attempt was let through; null when none is in flight. */
  probeStartedAt: number | null;
}

export const newBreaker = (cfg: BreakerConfig): HealingBreaker => ({ consecutiveFailures: 0, trippedUntil: null, cooldownMs: cfg.baseCooldownMs, probeStartedAt: null });

export type BreakerVerdict = "go" | "probe" | "stop";

export function breakerAdmit(state: HealingBreaker, now: number): { verdict: BreakerVerdict; state: HealingBreaker } {
  if (state.trippedUntil === null) return { verdict: "go", state };
  if (now < state.trippedUntil) return { verdict: "stop", state };
  if (state.probeStartedAt !== null && now - state.probeStartedAt < PROBE_TIMEOUT_MS) return { verdict: "stop", state };
  return { verdict: "probe", state: { ...state, probeStartedAt: now } };
}

export function breakerSuccess(_state: HealingBreaker, cfg: BreakerConfig): HealingBreaker {
  return newBreaker(cfg);
}

export function breakerFailure(state: HealingBreaker, cfg: BreakerConfig, now: number): { state: HealingBreaker; event: "none" | "tripped" | "reopened" } {
  if (state.trippedUntil !== null) {
    // Still open: nothing to add. Cooldown over (half-open): the probe failed, so open again for twice as long.
    if (now < state.trippedUntil) return { state, event: "none" };
    const cooldownMs = Math.min(state.cooldownMs * 2, MAX_BREAKER_COOLDOWN_MS);
    return { state: { consecutiveFailures: state.consecutiveFailures, trippedUntil: now + cooldownMs, cooldownMs, probeStartedAt: null }, event: "reopened" };
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures >= cfg.threshold) {
    return { state: { consecutiveFailures, trippedUntil: now + state.cooldownMs, cooldownMs: state.cooldownMs, probeStartedAt: null }, event: "tripped" };
  }
  return { state: { ...state, consecutiveFailures }, event: "none" };
}

/** The probe finished without saying anything about the platform's health (a customer's own error): free the slot, change nothing else. */
export function breakerReleaseProbe(state: HealingBreaker): HealingBreaker {
  return state.probeStartedAt === null ? state : { ...state, probeStartedAt: null };
}

/** True while open or half-open: for callers that must not take the probe slot themselves. */
export const breakerIsOpen = (state: HealingBreaker): boolean => state.trippedUntil !== null;
