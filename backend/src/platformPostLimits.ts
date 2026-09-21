// Per-platform rolling 24-hour posting caps (one connected social account at
// a time). Pinterest is strict with brand-new accounts and brand-new domains,
// and a real past Pinterest error read "maximum number of 10 posts for the
// last 24 hours for this account" -- LazyRelay had no cap of its own, so the
// customer only found out after Pinterest had already rejected the post. This
// module is the ONE place the limit lives; every writer of
// scheduled_posts.scheduled_for (see checkPlatformPostLimit in
// postCreation.ts) and the scheduler's send-time backstop (scheduler.ts)
// import it, so the number can never drift between them.
//
// Deliberately pure -- no supabase import (supabase.ts throws at import time
// without env vars), so the helpers below can be unit-tested with no database.
//
// Window definition (the one every helper here shares): a "24h window" is
// HALF-OPEN, [start, start + 24h). Two posts are in the same window only if
// they are strictly less than 24h apart, so a post exactly 24h after another
// is NOT in the same window as it (the older one has just aged out).

export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Which scheduled_posts statuses count toward a platform's rolling limit.
 *  draft/failed are excluded (they never went, and never will go, out), and
 *  so are paused posts (paused_at is set) -- a paused batch must not block
 *  new scheduling; resuming one is re-checked at resume time instead. There
 *  is no 'cancelled' status: cancelling a post deletes the row. */
export const COUNTED_POST_STATUSES = ["pending", "posting", "posted", "needs_approval"] as const;

export const DEFAULT_PINTEREST_DAILY_POST_LIMIT = 10;

/** Parses a positive-integer env override defensively. Anything that isn't
 *  a plain run of digits, or that is 0, falls back -- a typo in a Render env
 *  var must never silently disable a cap (NaN comparisons are always false)
 *  or block every post (a 0 or negative limit). */
export function parsePostLimitEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Platform -> max posts per connected account in any rolling 24h window.
 *  A platform absent from this map has no LazyRelay-side cap at all. */
export const PLATFORM_ROLLING_24H_POST_LIMIT: Record<string, number> = {
  pinterest: parsePostLimitEnv(process.env.PINTEREST_DAILY_POST_LIMIT, DEFAULT_PINTEREST_DAILY_POST_LIMIT),
};

/** The platform's cap, or null when it has none. */
export function getRolling24hPostLimit(platform: string): number | null {
  return PLATFORM_ROLLING_24H_POST_LIMIT[platform] ?? null;
}

/** True if adding a post at `newTime` would put MORE than `limit` posts
 *  inside any 24h window that contains `newTime`. Only windows containing
 *  newTime are considered: a window elsewhere that was already over the
 *  limit (legacy data from before this cap existed, say) isn't made worse by
 *  this post and shouldn't block scheduling on an unrelated day.
 *
 *  Any window can be slid right until its start sits on a post, so it is
 *  enough to try each existing post at or before newTime (and newTime itself)
 *  as a window start. Input order doesn't matter and isn't mutated. */
export function wouldExceedRolling24hLimit(existingTimes: Date[], newTime: Date, limit: number): boolean {
  const t = newTime.getTime();
  const times = existingTimes.map((d) => d.getTime());
  const starts = [t, ...times.filter((e) => e <= t && e > t - ROLLING_WINDOW_MS)];
  for (const start of starts) {
    const end = start + ROLLING_WINDOW_MS;
    // +1 for the new post itself, which sits inside every start we try.
    const count = 1 + times.filter((e) => e >= start && e < end).length;
    if (count > limit) return true;
  }
  return false;
}

/** Earliest time at or after `desiredTime` where a post would not exceed
 *  `limit`. The answer is either desiredTime itself or the moment an
 *  existing post ages out of its window (that post's time + 24h) -- capacity
 *  only ever frees up at one of those instants, so those are the only
 *  candidates worth testing. Always terminates: at the latest post's time
 *  + 24h no existing post is inside any window containing the new one. */
export function nextAllowedTime(existingTimes: Date[], desiredTime: Date, limit: number): Date {
  if (!wouldExceedRolling24hLimit(existingTimes, desiredTime, limit)) return new Date(desiredTime.getTime());
  const candidates = existingTimes
    .map((d) => d.getTime() + ROLLING_WINDOW_MS)
    .filter((c) => c > desiredTime.getTime())
    .sort((a, b) => a - b);
  for (const c of candidates) {
    const candidate = new Date(c);
    if (!wouldExceedRolling24hLimit(existingTimes, candidate, limit)) return candidate;
  }
  // Only reachable for a limit below 1 (nothing is ever allowed); hand back
  // the last candidate rather than loop or throw.
  return new Date(candidates.length > 0 ? candidates[candidates.length - 1] : desiredTime.getTime());
}

const PLATFORM_LIMIT_WORDING: Record<string, { name: string; noun: string }> = {
  pinterest: { name: "Pinterest", noun: "pins" },
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "September 22, 2026 at 14:30 UTC" -- the backend doesn't know the
 *  customer's timezone, so it states UTC plainly rather than guess one. */
function formatUtcTime(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${hh}:${mm} UTC`;
}

/** The customer-facing sentence for a rejected post. */
export function platformLimitMessage(platform: string, limit: number, nextAvailable: Date): string {
  const wording = PLATFORM_LIMIT_WORDING[platform] ?? { name: platform, noun: "posts" };
  return `${wording.name} allows up to ${limit} ${wording.noun} a day per account, and that day is full. The next free time is ${formatUtcTime(nextAvailable)}.`;
}
