// Audience growth — the polling half. Same external-script pattern as
// metricsPoller.ts, but deliberately a separate file rather than folded
// into it: metricsPoller's bounded six-checkpoint-then-stop design is built
// around a single post's engagement curve, which doesn't fit a slow-moving,
// account-level number like a follower count. One row per
// (social_account, day) via migration 0051_audience_snapshots.sql's unique
// constraint — running this more than once a day just upserts the same
// day's row rather than creating duplicates, so a daily schedule is a
// choice, not a hard requirement enforced here.
//
// Only polls accounts whose adapter declares getFollowerCount — see that
// method's doc comment on PlatformAdapter for exactly which platforms and
// why (Mastodon/Bluesky/YouTube only, for now; Meta/TikTok/Pinterest need
// scopes LazyRelay doesn't have).
import "dotenv/config";
import { supabase } from "./supabase.js";
import { buildPlatformRegistry } from "./platforms/registry.js";
import { getAccessToken } from "./scheduler.js";

// Added 2026-08-21, a real gap found during a scaling review: this was the
// only one of the four pollers with no cap at all -- no MAX_*_PER_RUN, no
// .limit() on the initial select, unlike mentionsAndDmsPoller.ts/
// dmAutomationPoller.ts/metricsPoller.ts, which all already have this
// pattern (their own comments note it spends each customer's own platform
// rate-limit budget, not LazyRelay's). At real account volume this would
// have been thousands of fully serial, uncapped outbound calls in one run.
const MAX_ACCOUNT_POLLS_PER_RUN = 1000;

async function main() {
  const registry = buildPlatformRegistry();

  const { data: accounts, error } = await supabase
    .from("social_accounts")
    .select("id, account_id, platform")
    .is("disconnected_at", null)
    .limit(1000);
  if (error) throw error;

  let polled = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of accounts ?? []) {
    if (polled + skipped + failed >= MAX_ACCOUNT_POLLS_PER_RUN) break;

    const adapter = registry.get(row.platform);
    if (!adapter?.getFollowerCount) {
      skipped++;
      continue;
    }
    try {
      const accessToken = await getAccessToken(row.id, adapter);
      const followerCount = await adapter.getFollowerCount(accessToken);
      if (followerCount === null) {
        console.error(`[audienceSnapshotPoller] getFollowerCount returned null for ${row.id} (${row.platform}) — see adapter log above for the HTTP reason`);
        failed++;
        continue;
      }
      const { error: upsertError } = await supabase
        .from("audience_snapshots")
        .upsert(
          {
            social_account_id: row.id,
            account_id: row.account_id,
            follower_count: followerCount,
            snapshot_date: new Date().toISOString().slice(0, 10),
          },
          { onConflict: "social_account_id,snapshot_date" },
        );
      if (upsertError) {
        console.error(`[audienceSnapshotPoller] upsert failed for ${row.id}:`, upsertError.message);
        failed++;
        continue;
      }
      polled++;
    } catch (err) {
      console.error(`[audienceSnapshotPoller] failed for ${row.id} (${row.platform}):`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  console.log(JSON.stringify({ polled, skipped, failed, totalAccounts: accounts?.length ?? 0 }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
