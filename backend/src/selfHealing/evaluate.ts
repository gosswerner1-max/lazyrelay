// The bridge between the scheduler's existing failure kinds and the new policy. Pure. Used for shadow mode (what the old logic did
// against what the new policy would have done) and to name the error class when the policy decides.

import type { PostErrorKind } from "../postErrors.js";
import { decideRetry, type ErrorClass, type ReasonCode } from "./policy.js";
import { shadowDiverged, type ShadowEvent } from "./shadow.js";

export function errorClassOf(kind: PostErrorKind, opts: { retryNotBefore?: number; ambiguous?: boolean } = {}): ErrorClass {
  if (kind === "fatal") return "fatal";
  if (kind === "reconnect") return "auth";
  if (opts.ambiguous) return "ambiguous";
  return opts.retryNotBefore ? "rate_limited" : "transient";
}

// What the old logic in scheduler.ts handleFailure does, replayed for the record. A test ties these numbers to the real behaviour.
const LEGACY_MAX_RETRIES = 3;
const LEGACY_BACKOFF_BASE_MS = 2 * 60_000;
const LEGACY_PLATFORM_WAIT_CAP_MS = 20 * 60_000;
const LEGACY_WHATSAPP_WAIT_CAP_MS = 25 * 60 * 60_000;

export interface LegacyOutcome {
  action: "retry" | "reverify" | "fail" | "hold_connection";
  delayMs: number | null;
  reasonCode: ReasonCode | null;
}

export function legacyOutcome(a: { kind: PostErrorKind; retryCount: number; platform: string; retryNotBefore?: number; ambiguous?: boolean; now: number }): LegacyOutcome {
  if (a.kind === "fatal") return { action: "fail", delayMs: null, reasonCode: "fatal" };
  if (a.kind === "reconnect") return { action: "hold_connection", delayMs: null, reasonCode: "auth_rejected" };
  if (a.retryCount >= LEGACY_MAX_RETRIES) return { action: "fail", delayMs: null, reasonCode: "retries_exhausted" };
  const backoff = LEGACY_BACKOFF_BASE_MS * 2 ** a.retryCount;
  const cap = a.platform === "whatsapp" ? LEGACY_WHATSAPP_WAIT_CAP_MS : LEGACY_PLATFORM_WAIT_CAP_MS;
  const platformWait = a.retryNotBefore ? Math.min(a.retryNotBefore - a.now, cap) : 0;
  return { action: a.ambiguous ? "reverify" : "retry", delayMs: Math.max(backoff, platformWait), reasonCode: null };
}

export function buildShadowEvent(a: {
  post: { id: string; social_account_id: string; platform: string; retry_count: number; scheduled_for?: string | null };
  kind: PostErrorKind;
  message: string;
  retryNotBefore?: number;
  ambiguous?: boolean;
  now: number;
  random: () => number;
  canRefresh: boolean;
  refreshTried: boolean;
}): ShadowEvent {
  const { post } = a;
  const scheduledFor = post.scheduled_for ? new Date(post.scheduled_for).getTime() : null;
  const errorClass = errorClassOf(a.kind, { retryNotBefore: a.retryNotBefore, ambiguous: a.ambiguous });
  const legacy = legacyOutcome({ kind: a.kind, retryCount: post.retry_count, platform: post.platform, retryNotBefore: a.retryNotBefore, ambiguous: a.ambiguous, now: a.now });
  const decision = decideRetry({
    errorClass,
    platform: post.platform,
    retryCount: post.retry_count,
    now: a.now,
    random: a.random,
    scheduledFor: scheduledFor !== null && Number.isFinite(scheduledFor) ? scheduledFor : null,
    platformWaitUntil: a.retryNotBefore,
    message: a.message,
    auth: { canRefresh: a.canRefresh, refreshTried: a.refreshTried },
  });

  const base = { source: "post" as const, postId: post.id, socialAccountId: post.social_account_id, platform: post.platform, errorClass, legacyAction: legacy.action, legacyDelayMs: legacy.delayMs };
  const lateAgainst = (at: number) => (scheduledFor !== null && Number.isFinite(scheduledFor) ? at - scheduledFor : null);

  if (decision.action === "retry" || decision.action === "reverify") {
    return {
      ...base,
      newAction: decision.action,
      newDelayMs: decision.delayMs,
      latenessMs: lateAgainst(decision.runAt),
      diverged: shadowDiverged({ legacyAction: legacy.action, legacyDelayMs: legacy.delayMs, legacyReasonCode: legacy.reasonCode, newAction: decision.action, newBaseDelayMs: decision.baseDelayMs, newReasonCode: null }),
    };
  }
  return {
    ...base,
    newAction: decision.action,
    newDelayMs: null,
    newReasonCode: decision.reason,
    latenessMs: lateAgainst(a.now),
    diverged: shadowDiverged({ legacyAction: legacy.action, legacyReasonCode: legacy.reasonCode, newAction: decision.action, newReasonCode: decision.reason }),
  };
}
