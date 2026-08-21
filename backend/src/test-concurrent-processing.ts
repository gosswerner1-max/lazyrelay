import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
import { StubAdapter } from "./platforms/stub.js";

// Proves the scheduler.ts fix (2026-08-21): a batch of due posts now runs
// concurrently, not serially. Real network round-trips to Supabase (claim,
// post_results insert, status updates) dominate total wall-clock time
// regardless of concurrency, so total elapsed time isn't a reliable signal
// on its own. What IS reliable: whether the 5 adapter.post() calls START
// within a tight window of each other. Serially, each post() call would
// only start after the previous post's ENTIRE pipeline (post + verify + DB
// writes) finished — call-start timestamps would be spread across the
// whole cycle. Concurrently, all 5 calls start together, right after
// claimDuePosts() resolves.
class DelayedStubAdapter extends StubAdapter {
  callStartTimestamps: number[] = [];

  async post(request: Parameters<StubAdapter["post"]>[0]) {
    this.callStartTimestamps.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 300));
    return super.post(request);
  }
}

async function main() {
  const email = `concurrency-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;

  try {
    const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
      p_token: "test-access-token-value",
    });
    if (vaultError) throw vaultError;

    const POST_COUNT = 5;
    const postIds: string[] = [];
    for (let i = 0; i < POST_COUNT; i++) {
      const { data: socialAccount, error: socialError } = await supabase
        .from("social_accounts")
        .insert({
          account_id: accountId,
          platform: "meta",
          platform_account_id: `test-page-concurrency-${i}`,
          display_name: `Test Page ${i}`,
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
          content: `Concurrency test post ${i}`,
          scheduled_for: new Date(Date.now() - 1000).toISOString(),
        })
        .select()
        .single();
      if (postError || !post) throw postError;
      postIds.push(post.id);
    }

    console.log(`Seeded ${POST_COUNT} due posts, each behind a 300ms artificial post() delay. Running scheduler cycle...`);
    const stubAdapter = new DelayedStubAdapter();
    const startedAt = Date.now();
    await runSchedulerCycle(new Map([[stubAdapter.platform, stubAdapter]]));
    const elapsedMs = Date.now() - startedAt;
    console.log(`Cycle took ${elapsedMs}ms total for ${POST_COUNT} posts (300ms artificial delay each, plus real Supabase network round-trips).`);

    const { data: finalPosts } = await supabase.from("scheduled_posts").select("id, status").in("id", postIds);
    const allPosted = (finalPosts ?? []).every((p) => p.status === "posted");

    const calls = stubAdapter.callStartTimestamps;
    const allCallsStarted = calls.length === POST_COUNT;
    const spreadMs = allCallsStarted ? Math.max(...calls) - Math.min(...calls) : Infinity;

    console.log(`All ${POST_COUNT} posts marked posted: ${allPosted}`);
    console.log(`post() call count: ${calls.length}/${POST_COUNT}; start-time spread across all calls: ${spreadMs}ms.`);
    console.log(`(Serial execution would spread these across the full ${elapsedMs}ms cycle, ~${Math.round(elapsedMs / POST_COUNT)}ms+ apart each; concurrent execution clusters them within a few hundred ms of each other.)`);

    // Threshold: scaled to the actual cycle time rather than a fixed
    // millisecond figure, since real Supabase network latency varies run to
    // run. Serially, 5 posts' call-starts would spread across nearly the
    // whole cycle (each call only starts once the previous post's full
    // pipeline finishes) — so spread ~= elapsedMs. Concurrently, all 5
    // calls fire within one pre-post-check round-trip of each other, a
    // small fraction of the total cycle time.
    const pass = allPosted && allCallsStarted && spreadMs < elapsedMs * 0.5;
    console.log(pass ? "PASS — batch processed concurrently, not serially." : "FAIL");
    if (!pass) process.exitCode = 1;
  } finally {
    await supabase.auth.admin.deleteUser(accountId);
  }
}

main().catch((err) => {
  console.error("Concurrency test failed:", err);
  process.exit(1);
});
