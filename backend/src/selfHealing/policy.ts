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
