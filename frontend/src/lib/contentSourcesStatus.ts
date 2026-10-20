// What the Content Sources status panel can honestly say. Everything is worked out from data the page really read: the
// customer's own scheduled posts and the service's readiness answer. A value that was not read is "unknown" and is never
// turned into a good-looking word.

import type { ScheduledPost } from "./api";

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
 * The badge. A service that does not answer beats everything and a paused queue beats a quiet unknown. Running needs two
 * things: the service answered, and there is proof of work (a post waiting to go out). A service that answers with nothing
 * waiting stays Unknown.
 */
export function deriveOverall(queue: QueueCounts, health: Health): Overall {
  if (health === "down") return "problem";
  if (queue.paused > 0 && queue.scheduled === 0) return "paused";
  if (health === "checking") return "checking";
  if (health === "ok" && queue.scheduled > 0) return "running";
  return "unknown";
}
