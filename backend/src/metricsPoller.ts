// Real engagement analytics — the polling half. Not a server process; run
// periodically by an external scheduled task (`node dist/metricsPoller.js`
// or `npx tsx src/metricsPoller.ts`), same external-script pattern as
// ops/health/run_health_check.js, so its cadence/failure isolation is
// decoupled from the main API process rather than a setInterval sibling.
//
// Bounded-snapshot design: each verified-live post gets checked at exactly
// six fixed checkpoints after it went live, then polling for that post
// stops for good — never one row per poll forever. See migration
// 0033_post_metrics.sql and werner-brain's
// project-competitor-feature-audit-2026-08-07.md for why.
import "dotenv/config";
import { supabase } from "./supabase.js";
import { buildPlatformRegistry } from "./platforms/registry.js";
import { getAccessToken } from "./scheduler.js";
import type { PlatformAdapter, PostMetrics } from "./platforms/types.js";

const CHECKPOINTS: { key: string; ms: number }[] = [
  { key: "1h", ms: 3600_000 },
  { key: "6h", ms: 6 * 3600_000 },
  { key: "24h", ms: 24 * 3600_000 },
  { key: "3d", ms: 3 * 24 * 3600_000 },
  { key: "7d", ms: 7 * 24 * 3600_000 },
  { key: "30d", ms: 30 * 24 * 3600_000 },
];

// Caps real outbound calls to each platform's own API per run — this is a
// customer's live rate-limit budget being spent, not LazyRelay's own. No
// per-platform rate-limit tracking exists yet (a real gap, flagged rather
// than silently ignored); this flat cap is the interim guardrail.
const MAX_POLLS_PER_RUN = 50;

interface CandidateRow {
  scheduledPostId: string;
  accountId: string;
  socialAccountId: string;
  platform: string;
  platformPostId: string;
  verificationCheckedAt: string;
  dueCheckpoints: string[];
}

function extractPlatform(social_accounts: unknown): string | null {
  // Same defensive shape-guard the analytics/summary route already uses —
  // Supabase's embedded-relationship result can come back as an array or a
  // single object depending on the join, and this codebase doesn't assume.
  if (Array.isArray(social_accounts)) return (social_accounts[0] as { platform?: string } | undefined)?.platform ?? null;
  return (social_accounts as { platform?: string } | null)?.platform ?? null;
}

async function main() {
  const registry = buildPlatformRegistry();

  // Only posts verified live within the last 31 days can still have an
  // uncollected checkpoint (30d is the last one) — bounds the scan instead
  // of re-reading every verified post this account has ever had.
  const since = new Date(Date.now() - 31 * 24 * 3600_000).toISOString();

  const { data: results, error } = await supabase
    .from("post_results")
    .select(
      "scheduled_post_id, account_id, platform_post_id, verification_checked_at, scheduled_posts(social_account_id, social_accounts(platform))"
    )
    .eq("verified_live", true)
    .not("platform_post_id", "is", null)
    .gte("verification_checked_at", since)
    .order("verification_checked_at", { ascending: true })
    .limit(1000);

  if (error) {
    console.error("metricsPoller: failed to read post_results:", error.message);
    process.exit(1);
  }

  const rows = results ?? [];
  if (rows.length === 0) {
    console.log("metricsPoller: no verified-live posts in the 31-day window. Nothing to do.");
    return;
  }

  // Batch-fetch which (scheduled_post_id, checkpoint) pairs already have a
  // row, so a post with nothing due yet is never re-fetched from the
  // platform just to find that out.
  const scheduledPostIds = rows.map((r) => r.scheduled_post_id);
  const { data: existingMetrics, error: existingError } = await supabase
    .from("post_metrics")
    .select("scheduled_post_id, checkpoint")
    .in("scheduled_post_id", scheduledPostIds);
  if (existingError) {
    console.error("metricsPoller: failed to read existing post_metrics:", existingError.message);
    process.exit(1);
  }
  const existingKeys = new Set((existingMetrics ?? []).map((m) => `${m.scheduled_post_id}:${m.checkpoint}`));

  const now = Date.now();
  const candidates: CandidateRow[] = [];
  for (const row of rows) {
    if (!row.verification_checked_at || !row.platform_post_id) continue;
    const platform = extractPlatform(row.scheduled_posts && (row.scheduled_posts as { social_accounts?: unknown }).social_accounts);
    if (!platform) continue;
    const adapter = registry.get(platform);
    if (!adapter?.getPostMetrics) continue; // honest "not supported" — see PlatformAdapter.getPostMetrics doc comment

    const elapsedMs = now - new Date(row.verification_checked_at).getTime();
    const dueCheckpoints = CHECKPOINTS.filter(
      (c) => elapsedMs >= c.ms && !existingKeys.has(`${row.scheduled_post_id}:${c.key}`)
    ).map((c) => c.key);
    if (dueCheckpoints.length === 0) continue;

    const socialAccountId = (row.scheduled_posts as { social_account_id?: string } | null)?.social_account_id;
    if (!socialAccountId) continue;

    candidates.push({
      scheduledPostId: row.scheduled_post_id,
      accountId: row.account_id,
      socialAccountId,
      platform,
      platformPostId: row.platform_post_id,
      verificationCheckedAt: row.verification_checked_at,
      dueCheckpoints,
    });
  }

  if (candidates.length === 0) {
    console.log(`metricsPoller: ${rows.length} verified-live posts checked, none have a due checkpoint. Nothing to do.`);
    return;
  }

  const toProcess = candidates.slice(0, MAX_POLLS_PER_RUN);
  if (candidates.length > MAX_POLLS_PER_RUN) {
    console.log(`metricsPoller: ${candidates.length} posts have a due checkpoint, capping this run to ${MAX_POLLS_PER_RUN} (oldest-verified first). The rest pick up next run.`);
  }

  let polled = 0;
  let inserted = 0;
  let errored = 0;

  for (const c of toProcess) {
    const adapter = registry.get(c.platform) as PlatformAdapter;
    let metrics: PostMetrics;
    try {
      const accessToken = await getAccessToken(c.socialAccountId, adapter);
      metrics = await adapter.getPostMetrics!(c.platformPostId, accessToken);
    } catch (err) {
      metrics = {
        likes: null,
        comments: null,
        shares: null,
        views: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    polled += 1;

    // Same fetched value backfills every currently-due checkpoint for this
    // post (normally just one — the rare case is the poller having missed
    // a run and catching up on 2+ checkpoints at once). A backfilled slot
    // represents "measured late," not the true historical value at that
    // exact checkpoint age; there is no way to recover the real one after
    // the fact, and re-polling per checkpoint would just burn extra calls
    // to fetch an identical current number.
    const rowsToInsert = c.dueCheckpoints.map((checkpoint) => ({
      scheduled_post_id: c.scheduledPostId,
      account_id: c.accountId,
      checkpoint,
      likes: metrics.likes,
      comments: metrics.comments,
      shares: metrics.shares,
      views: metrics.views,
      error_message: metrics.errorMessage,
    }));

    const { error: insertError } = await supabase
      .from("post_metrics")
      .upsert(rowsToInsert, { onConflict: "scheduled_post_id,checkpoint" });
    if (insertError) {
      console.error(`metricsPoller: failed to save metrics for ${c.scheduledPostId}:`, insertError.message);
      errored += 1;
    } else {
      inserted += rowsToInsert.length;
    }
  }

  console.log(
    `metricsPoller: ${rows.length} verified-live posts scanned, ${candidates.length} had a due checkpoint, ${polled} polled (capped at ${MAX_POLLS_PER_RUN}), ${inserted} checkpoint rows saved, ${errored} save errors.`
  );
}

main().catch((err) => {
  console.error("metricsPoller: unhandled error:", err);
  process.exit(1);
});
