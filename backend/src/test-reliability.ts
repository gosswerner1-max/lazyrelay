import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
import type {
  PlatformAdapter,
  PostRequest,
  PostAttemptResult,
  VerifyResult,
  OAuthExchangeResult,
} from "./platforms/types.js";

// One-off manual smoke test — proves the retry/backoff and circuit-breaker
// logic added to scheduler.ts actually work against the real Supabase
// project, not just that they typecheck. Deletable once real integration
// tests exist (same convention as test-e2e.ts).

/** Always fails post() with a distinct error per call, so we can watch
 *  retry_count/status/scheduled_for evolve across scheduler cycles without
 *  a real platform in the loop. */
class AlwaysFailsAdapter implements PlatformAdapter {
  readonly platform: "meta" = "meta";
  callCount = 0;

  getAuthorizeUrl(state: string): string {
    return `https://stub.invalid/oauth/authorize?state=${encodeURIComponent(state)}`;
  }
  async exchangeCode(): Promise<OAuthExchangeResult> {
    throw new Error("not used in this test");
  }
  async post(_request: PostRequest): Promise<PostAttemptResult> {
    this.callCount += 1;
    return { success: false, platformPostId: null, errorMessage: `simulated failure #${this.callCount}` };
  }
  async verifyPublished(): Promise<VerifyResult> {
    throw new Error("not used in this test — post() already fails");
  }
}

async function seedAccountWithDuePost(): Promise<{ accountId: string; postId: string }> {
  const email = `reliability-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;

  // handle_new_user() already auto-creates the accounts row on signup (see
  // reference-lazyrelay-split / accounts_ops.js audit notes) — upsert
  // instead of insert so this doesn't collide with that trigger.
  const { error: accountError } = await supabase.from("accounts").upsert({ id: accountId, email });
  if (accountError) throw accountError;

  const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
    p_token: "test-access-token-value",
  });
  if (vaultError) throw vaultError;

  const { data: socialAccount, error: socialError } = await supabase
    .from("social_accounts")
    .insert({
      account_id: accountId,
      platform: "meta",
      platform_account_id: `test-page-${Date.now()}`,
      display_name: "Reliability Test Page",
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
      content: "Reliability test post",
      scheduled_for: new Date(Date.now() - 1000).toISOString(), // already due
    })
    .select()
    .single();
  if (postError || !post) throw postError;

  return { accountId, postId: post.id };
}

async function getPostState(postId: string) {
  const { data, error } = await supabase
    .from("scheduled_posts")
    .select("status, retry_count, scheduled_for")
    .eq("id", postId)
    .single();
  if (error) throw error;
  return data;
}

async function main() {
  let pass = true;

  // --- Test 1: retry-then-permanent-failure, with backoff ---
  console.log("\n=== Test 1: retry with backoff, then permanent failure ===");
  const { accountId: accountId1, postId: postId1 } = await seedAccountWithDuePost();
  const adapter1 = new AlwaysFailsAdapter();

  // Attempt 1: fails, should go back to pending with retry_count=1 and a
  // future scheduled_for (backoff), NOT "failed".
  await runSchedulerCycle(adapter1);
  let state = await getPostState(postId1);
  console.log("After attempt 1:", state);
  const backoffApplied = state.status === "pending" && state.retry_count === 1 && new Date(state.scheduled_for) > new Date();
  if (!backoffApplied) {
    console.error("FAIL: expected pending, retry_count=1, scheduled_for in the future after first failure.");
    pass = false;
  }

  // Force the retry to be due now (don't wait out the real backoff in a test).
  await supabase.from("scheduled_posts").update({ scheduled_for: new Date(Date.now() - 1000).toISOString() }).eq("id", postId1);

  // Attempts 2, 3, 4 (retry_count goes 1->2, 2->3, 3->4 = MAX_RETRIES exceeded -> permanently failed on the 4th attempt)
  for (let i = 0; i < 3; i++) {
    await runSchedulerCycle(adapter1);
    state = await getPostState(postId1);
    if (state.status === "pending") {
      await supabase.from("scheduled_posts").update({ scheduled_for: new Date(Date.now() - 1000).toISOString() }).eq("id", postId1);
    }
  }
  console.log("After exhausting retries:", state);
  if (state.status !== "failed") {
    console.error(`FAIL: expected status "failed" after exhausting retries, got "${state.status}".`);
    pass = false;
  } else {
    console.log("PASS: post correctly marked failed only after exhausting retries, not on first failure.");
  }

  await supabase.auth.admin.deleteUser(accountId1);

  // --- Test 2: circuit breaker trips after consecutive failures ---
  console.log("\n=== Test 2: circuit breaker trips and skips further cycles ===");
  const { accountId: accountId2, postId: postId2 } = await seedAccountWithDuePost();
  const adapter2 = new AlwaysFailsAdapter();

  // Drive 5 consecutive failures (CONSECUTIVE_FAILURE_THRESHOLD) across
  // separate due posts so the breaker's failure count actually increments
  // 5 times, then confirm a 6th cycle is skipped entirely (breaker open).
  const extraPostIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const { data: sp } = await supabase
      .from("social_accounts")
      .select("id")
      .eq("account_id", accountId2)
      .single();
    const { data: extraPost } = await supabase
      .from("scheduled_posts")
      .insert({
        account_id: accountId2,
        social_account_id: sp!.id,
        content: `breaker test post ${i}`,
        scheduled_for: new Date(Date.now() - 1000).toISOString(),
      })
      .select()
      .single();
    extraPostIds.push(extraPost!.id);
  }

  // Cycle 1 processes postId2 (1 failure); cycles 2-5 each process one of
  // the 4 extra posts (failures 2-5) -> breaker should trip after failure 5.
  await runSchedulerCycle(adapter2); // failure 1 (postId2)
  for (const id of extraPostIds) {
    await supabase.from("scheduled_posts").update({ scheduled_for: new Date(Date.now() - 1000).toISOString() }).eq("id", id);
    await runSchedulerCycle(adapter2);
  }

  const callsBeforeBreakerCheck = adapter2.callCount;
  console.log(`adapter.post() called ${callsBeforeBreakerCheck} times so far (expected 5).`);

  // Seed one more due post and run a cycle — if the breaker is open, this
  // post should stay untouched (still pending, unclaimed) and callCount
  // should NOT increase.
  const { data: sp2 } = await supabase.from("social_accounts").select("id").eq("account_id", accountId2).single();
  const { data: postAfterTrip } = await supabase
    .from("scheduled_posts")
    .insert({
      account_id: accountId2,
      social_account_id: sp2!.id,
      content: "post seeded after breaker should have tripped",
      scheduled_for: new Date(Date.now() - 1000).toISOString(),
    })
    .select()
    .single();

  await runSchedulerCycle(adapter2);
  const stateAfterTrip = await getPostState(postAfterTrip!.id);
  console.log("Post seeded after trip:", stateAfterTrip, `| adapter.post() calls now: ${adapter2.callCount}`);

  const breakerHeld = stateAfterTrip.status === "pending" && adapter2.callCount === callsBeforeBreakerCheck;
  if (!breakerHeld) {
    console.error("FAIL: expected the circuit breaker to be open (post left untouched, no new adapter.post() calls).");
    pass = false;
  } else {
    console.log("PASS: circuit breaker correctly opened after 5 consecutive failures and skipped the next cycle.");
  }

  await supabase.auth.admin.deleteUser(accountId2);

  console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error("Reliability test failed:", err);
  process.exit(1);
});
