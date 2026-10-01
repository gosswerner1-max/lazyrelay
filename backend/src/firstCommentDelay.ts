// Delay before the first comment. A post can hold its first comment back a
// chosen number of minutes after the post goes live (a known engagement tactic).
// 0 or empty means "right away", exactly as before. The scheduler stamps
// post_results.first_comment_due_at when the main post is confirmed live, and a
// later pass (scheduler.ts runFirstCommentPass) posts it once it is due.

/** Platforms whose adapter posts the first comment and that may delay it. */
export const FIRST_COMMENT_DELAY_PLATFORMS = ["facebook", "instagram"];
export const MAX_FIRST_COMMENT_DELAY_MINUTES = 1440;
/** A comment more than this long past its due time is marked failed, not posted. */
export const FIRST_COMMENT_STALE_AFTER_MS = 24 * 60 * 60_000;

export const FIRST_COMMENT_DELAY_OPTIONS = [0, 5, 15, 30, 60, 120, 360, 1440];

type Result = { ok: true; value: number | null } | { ok: false; error: string };

function hasComment(firstComment: unknown): boolean {
  return typeof firstComment === "string" && firstComment.trim() !== "";
}

/**
 * Checks a delay value. Returns the number to store (null for "right away"/not given).
 * `platform` is null for a draft, which has no platform yet (that check runs when the
 * draft is scheduled).
 */
export function normalizeFirstCommentDelay(delay: unknown, firstComment: unknown, platform: string | null): Result {
  if (delay === undefined || delay === null || delay === "") return { ok: true, value: null };
  const n = typeof delay === "number" ? delay : typeof delay === "string" && delay.trim() !== "" ? Number(delay) : NaN;
  if (!Number.isInteger(n)) return { ok: false, error: "firstCommentDelayMinutes must be a whole number of minutes" };
  if (n < 0) return { ok: false, error: "firstCommentDelayMinutes can't be negative" };
  if (n > MAX_FIRST_COMMENT_DELAY_MINUTES) {
    return { ok: false, error: `firstCommentDelayMinutes can be at most ${MAX_FIRST_COMMENT_DELAY_MINUTES} minutes (24 hours)` };
  }
  if (n === 0) return { ok: true, value: null };
  if (!hasComment(firstComment)) return { ok: false, error: "A delay before the first comment needs a first comment to delay" };
  if (platform !== null && !FIRST_COMMENT_DELAY_PLATFORMS.includes(platform)) {
    return { ok: false, error: "Delaying the first comment is only available for Facebook and Instagram posts" };
  }
  return { ok: true, value: n };
}

/** Recurring schedules cover several platforms: the delay applies only where it is supported. */
export function delayForPlatform(
  slot: { first_comment?: string | null; first_comment_delay_minutes?: number | null },
  platform: string,
): number | null {
  const n = normalizeFirstCommentDelay(slot.first_comment_delay_minutes ?? null, slot.first_comment ?? null, platform);
  return n.ok ? n.value : null;
}

/** When a delayed comment is due, from the moment the main post was confirmed live. */
export function firstCommentDueAt(delayMinutes: number | null | undefined, now: number): string | null {
  if (!delayMinutes || delayMinutes <= 0) return null;
  return new Date(now + delayMinutes * 60_000).toISOString();
}

export type DueDecision = "wait" | "post" | "stale";

/** Decides what the pass does with a comment whose due time is `dueAt`. */
export function decideFirstComment(dueAt: string, now: number): DueDecision {
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due) || due > now) return "wait";
  return now - due > FIRST_COMMENT_STALE_AFTER_MS ? "stale" : "post";
}
