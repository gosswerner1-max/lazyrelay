import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
import { StubAdapter } from "./platforms/stub.js";

// Answers a real question, not a hypothetical: "what's our actual current
// publishing capacity, and what's the real bottleneck if we exceed it?"
// Not run on a stub-speed adapter with no delay — that would just measure
// Supabase round-trip time, which was never in question. RESPONSE_DELAY_MS
// is a stand-in for real platform-API latency (we don't have LazyRelay's own
// per-platform latency instrumented in production yet), not a measured
// number — reported honestly as an estimate, not fact.
const RESPONSE_DELAY_MS = 350;
class RealisticDelayAdapter extends StubAdapter {
  async post(request: Parameters<StubAdapter["post"]>[0]) {
    await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));
    return super.post(request);
  }
  async verifyPublished(platformPostId: string) {
    await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));
    return super.verifyPublished(platformPostId);
  }
}

async function seedDuePosts(accountId: string, vaultId: string, count: number, labelPrefix: string) {
  const postIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const { data: socialAccount, error: socialError } = await supabase
      .from("social_accounts")
      .insert({
        account_id: accountId,
        platform: "meta",
        platform_account_id: `${labelPrefix}-${i}`,
        display_name: `${labelPrefix} ${i}`,
        access_token_vault_id: vaultId,
      })
      .select()
      .single();
    if (socialError || !socialAccount) throw socialError;

    const { data: post, error: postError } = await supabase
      .from("scheduled_posts")
      .insert({
        account_id: accountId,
        social_account_id: socialAccount.id,
        content: `${labelPrefix} post ${i}`,
        scheduled_for: new Date(Date.now() - 1000).toISOString(),
      })
      .select()
      .single();
    if (postError || !post) throw postError;
    postIds.push(post.id);
  }
  return postIds;
}

async function countPosted(postIds: string[]): Promise<number> {
  const { data } = await supabase.from("scheduled_posts").select("id, status").in("id", postIds);
  return (data ?? []).filter((p) => p.status === "posted").length;
}

async function main() {
  const email = `throughput-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;

  try {
    const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
      p_token: "test-access-token-value",
    });
    if (vaultError) throw vaultError;

    // ===== Part A: real sustained drain, real 30s cadence (matches
    // index.ts's actual production POLL_INTERVAL_MS) — measures the
    // system's real current throughput ceiling, not a synchronized burst. =====
    const PART_A_COUNT = 60;
    console.log(`\n=== Part A: seeding ${PART_A_COUNT} due posts on one platform ("meta"), real 30s poll cadence ===`);
    const partAIds = await seedDuePosts(accountId, vaultId, PART_A_COUNT, "throughput-a");
    const adapter = new RealisticDelayAdapter();
    const registry = new Map([[adapter.platform, adapter]]);

    const partAStart = Date.now();
    let cycle = 0;
    const MAX_CYCLES = 10;
    while (cycle < MAX_CYCLES) {
      cycle++;
      const cycleStart = Date.now();
      await runSchedulerCycle(registry);
      const cycleElapsedMs = Date.now() - cycleStart;
      const posted = await countPosted(partAIds);
      const totalElapsedS = ((Date.now() - partAStart) / 1000).toFixed(1);
      console.log(
        `  Cycle ${cycle}: took ${cycleElapsedMs}ms to process this batch. Posted so far: ${posted}/${PART_A_COUNT}. Total elapsed: ${totalElapsedS}s.`
      );
      if (posted >= PART_A_COUNT) break;
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
    const partAElapsedMs = Date.now() - partAStart;
    const partAPosted = await countPosted(partAIds);
    const partAThroughputPerMin = partAPosted / (partAElapsedMs / 60_000);
    console.log(
      `Part A result: ${partAPosted}/${PART_A_COUNT} posted in ${(partAElapsedMs / 1000).toFixed(1)}s (${cycle} cycles) — ~${partAThroughputPerMin.toFixed(1)} posts/min sustained.`
    );

    // ===== Part B: headroom stress — what if CLAIM_BATCH_SIZE were much
    // bigger than 10? Doesn't touch scheduler.ts; drives a much larger
    // concurrent batch directly against the same delay adapter + real
    // Supabase writes, to see whether Render/Supabase (not our own
    // self-imposed batch size) would be the next real constraint. =====
    const PART_B_COUNT = 80;
    console.log(`\n=== Part B: ${PART_B_COUNT}-way concurrent batch (simulating a much larger CLAIM_BATCH_SIZE) ===`);
    const partBIds = await seedDuePosts(accountId, vaultId, PART_B_COUNT, "throughput-b");
    const { data: partBPosts } = await supabase
      .from("scheduled_posts")
      .select("id, social_account_id, content")
      .in("id", partBIds);

    const partBStart = Date.now();
    const partBAdapter = new RealisticDelayAdapter();
    const results = await Promise.all(
      (partBPosts ?? []).map(async (post) => {
        try {
          const attempt = await partBAdapter.post({
            socialAccountId: post.social_account_id,
            content: post.content,
            mediaUrl: null,
            coverImageUrl: null,
            boardId: null,
            destinationLink: null,
            mediaAltText: null,
            accessToken: "test-access-token-value",
          });
          const verification = await partBAdapter.verifyPublished(attempt.platformPostId!);
          await supabase.from("scheduled_posts").update({ status: verification.verifiedLive ? "posted" : "failed" }).eq("id", post.id);
          return { ok: verification.verifiedLive };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      })
    );
    const partBElapsedMs = Date.now() - partBStart;
    const partBSucceeded = results.filter((r) => r.ok).length;
    console.log(
      `Part B result: ${partBSucceeded}/${PART_B_COUNT} succeeded in ${(partBElapsedMs / 1000).toFixed(1)}s, fully concurrent (no batching), real Supabase writes throughout.`
    );

    console.log("\n=== SUMMARY ===");
    console.log(JSON.stringify({
      partA_currentRealCeiling: {
        posted: partAPosted,
        of: PART_A_COUNT,
        elapsedSeconds: Math.round(partAElapsedMs / 1000),
        cycles: cycle,
        postsPerMinute: Math.round(partAThroughputPerMin * 10) / 10,
      },
      partB_headroomAt80Concurrent: {
        succeeded: partBSucceeded,
        of: PART_B_COUNT,
        elapsedSeconds: Math.round(partBElapsedMs / 1000),
      },
    }, null, 2));
  } finally {
    await supabase.auth.admin.deleteUser(accountId);
  }
}

main().catch((err) => {
  console.error("Throughput capacity test failed:", err);
  process.exit(1);
});
