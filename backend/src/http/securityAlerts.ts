import { notifyOps } from "../notify.js";

/** Lightweight in-process spike detector for security-relevant HTTP
 *  rejections (401/403 auth denials, 429 rate-limit hits). Not a general
 *  logging system — it exists to answer one question: "is someone hammering
 *  us right now?" and page Slack via notifyOps() if so, same channel the
 *  scheduler's own failure alerts already use.
 *
 *  Deliberately in-memory, not DB-backed: this only needs to survive a few
 *  minutes to catch a live spike, and a process restart clearing the
 *  counters is fine — a fresh spike re-triggers on its own. If this ever
 *  runs across multiple Render instances, each instance's counters are
 *  independent, so a distributed attack could stay under any one instance's
 *  threshold — acceptable for the single-instance deployment this runs on
 *  today, worth revisiting if that changes. */

interface EventBucket {
  count: number;
  windowStart: number;
  lastAlertAt: number;
}

const WINDOW_MS = 5 * 60_000; // 5 minutes
const ALERT_COOLDOWN_MS = 15 * 60_000; // don't re-alert on the same ongoing spike more than every 15 min

const THRESHOLDS: Record<string, number> = {
  auth_denied: 20, // 401/403 from requireAuth/requireOwner/requireHumanAuth/requireAdmin
  rate_limited: 30, // 429s across all limiters
  admin_key_revoked: 1, // any auto-revoke is worth an immediate page, not a spike wait
  mfa_recovery_used: 1, // someone bypassed their second factor -- rare and worth knowing about individually, same as admin_key_revoked
};

const buckets = new Map<string, EventBucket>();

export function recordSecurityEvent(type: keyof typeof THRESHOLDS, detail: string): void {
  const now = Date.now();
  const bucket = buckets.get(type) ?? { count: 0, windowStart: now, lastAlertAt: 0 };

  if (now - bucket.windowStart > WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  bucket.count += 1;
  buckets.set(type, bucket);

  const threshold = THRESHOLDS[type];
  if (bucket.count >= threshold && now - bucket.lastAlertAt > ALERT_COOLDOWN_MS) {
    bucket.lastAlertAt = now;
    void notifyOps(
      `Security alert: ${bucket.count} "${type}" events in the last ${Math.round(WINDOW_MS / 60_000)} min (threshold ${threshold}). Latest: ${detail}`
    );
  }
}
