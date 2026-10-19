// WhatsApp fault tracking for the owner digest, and what an unknown Meta error code means. Pure apart from reading the repo's own
// error map (postErrors.ts): only codes that map already classifies are treated as known, nothing here invents a Meta code.

import { classifyPostError, WHATSAPP_DEFER_MS } from "../postErrors.js";

export type SendOutcome = "ok" | "recipient_failed" | "account_fault";

export const FAULT_WINDOW_SIZE = 50;
export const FAULT_MIN_SENDS = 10;
export const FAULT_RATIO = 0.2;
export const FAULT_CONSECUTIVE = 5;
export const FAULT_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;
/** An unknown Meta code is tried this many times in all, then it is terminal unknown_error. */
export const UNKNOWN_MAX_ATTEMPTS = 3;

/** The last FAULT_WINDOW_SIZE outcomes, oldest first. Returns a new list. */
export function pushOutcome(window: readonly SendOutcome[], outcome: SendOutcome): SendOutcome[] {
  return [...window, outcome].slice(-FAULT_WINDOW_SIZE);
}

export interface FaultAssessment {
  alert: boolean;
  trigger: "consecutive" | "ratio" | null;
  sends: number;
  failed: number;
  recipientLevel: number;
  accountLevel: number;
}

/** An alert is due when the last 5 sends all failed, or at least 20 percent of the last 50 failed (with at least 10 sends). */
export function assessFaults(window: readonly SendOutcome[]): FaultAssessment {
  const w = window.slice(-FAULT_WINDOW_SIZE);
  const failed = w.filter((o) => o !== "ok").length;
  const recipientLevel = w.filter((o) => o === "recipient_failed").length;
  const accountLevel = w.filter((o) => o === "account_fault").length;
  const consecutive = w.length >= FAULT_CONSECUTIVE && w.slice(-FAULT_CONSECUTIVE).every((o) => o !== "ok");
  const ratio = w.length >= FAULT_MIN_SENDS && failed / w.length >= FAULT_RATIO;
  return { alert: consecutive || ratio, trigger: consecutive ? "consecutive" : ratio ? "ratio" : null, sends: w.length, failed, recipientLevel, accountLevel };
}

/** True when 6 hours have passed since the last alert. A stored time that cannot be read counts as recent (no second email). */
export function cooldownElapsed(lastAlertAt: string | null, now: number): boolean {
  if (lastAlertAt === null) return true;
  const t = new Date(lastAlertAt).getTime();
  return Number.isFinite(t) && now - t >= FAULT_ALERT_COOLDOWN_MS;
}

/** A rejection with no code, or a code the repo's error map does not classify as permanent. Codes the sender already handles (an
 *  opt-out, a pause, a template problem, a transient error) never reach here. */
export function isUnknownMetaFailure(code: number | null): boolean {
  return code === null || classifyPostError("whatsapp", `code=${code}`).kind !== "fatal";
}

export interface UnknownFailurePlan {
  terminal: boolean;
  reason: "unknown_error" | null;
  delayMs: number | null;
}

/** What to do with an unknown failure on the given attempt (1 is the first): try again, or give up as unknown_error. `backoffMs` is
 *  the sender's own retry delay for that attempt; a longer wait the repo already knows for the code (131049) is honoured instead. */
export function planUnknownFailure(a: { attemptCount: number; code: number | null; backoffMs: number }): UnknownFailurePlan {
  if (a.attemptCount >= UNKNOWN_MAX_ATTEMPTS) return { terminal: true, reason: "unknown_error", delayMs: null };
  const wait = a.code !== null && classifyPostError("whatsapp", `code=${a.code}`).retryNotBefore ? WHATSAPP_DEFER_MS : 0;
  return { terminal: false, reason: null, delayMs: Math.max(a.backoffMs, wait) };
}
