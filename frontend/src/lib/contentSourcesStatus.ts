// What the Content Sources status panel can honestly say. Everything is worked out from data the page really read: the
// customer's own scheduled posts, the sources list, and the service's readiness answer. A value that was not read is
// "unknown" and is never turned into a good-looking word.

import type { ScheduledPost } from "./api";
import type { ServiceSource } from "./contentSources";

export interface QueueCounts {
  scheduled: number;
  paused: number;
}

/** Only posts waiting to go out count. A paused post is still pending, just held back. */
export function summarizeQueue(posts: readonly ScheduledPost[]): QueueCounts {
  let scheduled = 0;
  let paused = 0;
  for (const post of posts) {
    if (post.status !== "pending") continue;
    if (post.paused_at) paused += 1;
    else scheduled += 1;
  }
  return { scheduled, paused };
}

export function describeQueue({ scheduled, paused }: QueueCounts): string {
  if (scheduled === 0 && paused === 0) return "Nothing scheduled";
  if (scheduled === 0) return "Posting is paused";
  return paused > 0 ? `${scheduled} scheduled, ${paused} paused` : `${scheduled} scheduled`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Last checked 12 minutes ago", "Never run", or "Unknown" when the time cannot be read. */
export function describeLastChecked(iso: string | null, now: number): string {
  if (iso === null) return "Never run";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "Unknown";
  const age = now - then;
  if (age < MINUTE_MS) return "Last checked less than a minute ago"; // also covers a clock a little ahead of ours
  if (age < HOUR_MS) return `Last checked ${plural(Math.floor(age / MINUTE_MS), "minute")} ago`;
  if (age < DAY_MS) return `Last checked ${plural(Math.floor(age / HOUR_MS), "hour")} ago`;
  return `Last checked ${plural(Math.floor(age / DAY_MS), "day")} ago`;
}

export type Health = "checking" | "ok" | "down" | "unknown";
export type Overall = "checking" | "running" | "paused" | "problem" | "unknown";

export const OVERALL_WORDS: Record<Overall, string> = {
  checking: "Checking",
  running: "Running",
  paused: "Paused",
  problem: "Problem",
  unknown: "Unknown",
};

export const HEALTH_WORDS: Record<Health, string> = {
  checking: "Checking...",
  ok: "OK",
  down: "Not reachable",
  unknown: "Unknown",
};

/**
 * The badge. A problem beats everything and a paused queue beats a quiet unknown. Running needs two things: the service
 * answered, and there is proof of work (a post waiting to go out, or a source that has really run). A service that answers
 * with nothing to show for it stays Unknown. Sources that were not read (null) can never show Running.
 */
export function deriveOverall(queue: QueueCounts, sources: readonly ServiceSource[] | null, health: Health): Overall {
  if (health === "down" || (sources ?? []).some((s) => s.lastError)) return "problem";
  if (queue.paused > 0 && queue.scheduled === 0) return "paused";
  if (health === "checking") return "checking";
  const proofOfWork = queue.scheduled > 0 || (sources ?? []).some((s) => s.lastSyncedAt !== null);
  if (health === "ok" && sources !== null && proofOfWork) return "running";
  return "unknown";
}
