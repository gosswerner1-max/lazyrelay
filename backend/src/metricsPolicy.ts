// Which posts the metrics poller may read back. X "bring your own key" connections are never polled: every X read is
// billed to the customer's own X developer wallet (about $0.005 each), and the poller would make six of them per post
// (1h, 6h, 24h, 3d, 7d, 30d) for the life of the account. The single read that proves a post is live (verifyPublished)
// stays; it is part of Proof-of-Publish and is disclosed in the setup guide.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Drops the candidates that belong to an X connection using the customer's own keys. Every other candidate, including
 *  X connections on platform credentials, passes through untouched. The credential_mode lookup happens only when an X
 *  candidate exists, so the column is never needed (nor selected) otherwise. If the lookup fails, X candidates are
 *  dropped for this run: skipping a poll costs nothing, a wrong one costs the customer money. */
export async function withoutByokXReads<T extends { platform: string; socialAccountId: string }>(
  candidates: T[],
  db: Pick<SupabaseClient, "from">,
): Promise<T[]> {
  const xIds = [...new Set(candidates.filter((c) => c.platform === "x").map((c) => c.socialAccountId))];
  if (xIds.length === 0) return candidates;
  const { data, error } = await db.from("social_accounts").select("id, credential_mode").in("id", xIds);
  if (error) {
    console.warn(`metricsPoller: could not read the X credential mode (${error.message}); X posts are skipped this run.`);
    return candidates.filter((c) => c.platform !== "x");
  }
  const byok = new Set((data ?? []).filter((r) => r.credential_mode === "byok").map((r) => r.id as string));
  return candidates.filter((c) => !(c.platform === "x" && byok.has(c.socialAccountId)));
}
