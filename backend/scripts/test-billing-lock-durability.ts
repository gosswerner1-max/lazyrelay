// SECURITY FIX (2026-09-25) verification: the five double-purchase
// concurrency guards in routes.ts used to share one in-memory Set
// (`pendingTierChanges`), which only ever protected a single Node process --
// a Render zero-downtime deploy briefly runs two processes, each with its
// own empty Set, reopening the race those guards exist to close. Replaced
// with a durable lock backed by a real Supabase row (billing_action_locks,
// migration 0091) via billing/locks.ts.
//
// This proves, against the real Supabase project (no mocking -- the task
// this fix is for explicitly allows testing the lock table for real, since
// it's not billing money movement itself):
//  1. two "concurrent processes" (two sequential acquire calls, the first
//     never released) -- the second correctly fails to acquire.
//  2. releasing frees the lock for a subsequent acquire.
//  3. a lock whose TTL has expired (simulating a process that crashed
//     mid-request across a deploy, or an old process's stale lock outliving
//     the deploy overlap) is correctly stolen by the next acquire instead of
//     blocking forever -- this is the actual fix for the Render
//     zero-downtime-deploy race the in-memory Set couldn't survive.
//
// No HTTP layer, no Paddle adapter of any kind involved -- this is a direct,
// real Supabase read/write test of the new lock module.
//
// Run: npx tsx scripts/test-billing-lock-durability.ts
import "dotenv/config";
import { supabase } from "../src/supabase.js";
import { acquireBillingLock, releaseBillingLock } from "../src/billing/locks.js";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}${detail ? `\n        -> ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `\n        -> ${detail}` : ""}`);
  }
}

async function main() {
  const email = `billing-lock-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  try {
    // 1. "Process A" acquires the lock for a checkout.
    const firstAcquire = await acquireBillingLock(accountId, "subscription/checkout");
    check("process A acquires the lock (first attempt, nothing held yet)", firstAcquire === true);

    // 2. "Process B" -- a concurrent request for the SAME account, e.g. a
    // double-click or a second open tab -- tries to acquire the same lock
    // before process A has released it. Must fail. This is the exact
    // scenario the in-memory Set could not protect across two processes.
    const secondAcquire = await acquireBillingLock(accountId, "storage-addons/checkout");
    check("process B fails to acquire the same account's lock while process A still holds it", secondAcquire === false);

    // Confirm exactly one row exists and it's still process A's action.
    const { data: rowWhileHeld } = await supabase.from("billing_action_locks").select("action").eq("account_id", accountId).single();
    check(
      "the lock row still reflects process A's action, untouched by process B's failed attempt",
      rowWhileHeld?.action === "subscription/checkout",
      JSON.stringify(rowWhileHeld),
    );

    // 3. Process A releases (its `finally` block running).
    await releaseBillingLock(accountId);
    const { data: rowAfterRelease } = await supabase.from("billing_action_locks").select("account_id").eq("account_id", accountId).maybeSingle();
    check("releasing removes the lock row entirely", rowAfterRelease === null, JSON.stringify(rowAfterRelease));

    // 4. Now a fresh request for the same account can acquire it.
    const thirdAcquire = await acquireBillingLock(accountId, "subscription/change-tier");
    check("a new request acquires the lock once the prior one released it", thirdAcquire === true);

    // 5. Simulate a process that crashed mid-request (or an old process
    // still holding a lock across a Render deploy overlap) by forcing this
    // lock's expires_at into the past directly in the DB -- exactly what a
    // stale, orphaned lock row looks like in production.
    const { error: expireError } = await supabase
      .from("billing_action_locks")
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("account_id", accountId);
    if (expireError) throw expireError;

    const stolenAcquire = await acquireBillingLock(accountId, "brand-addons/checkout");
    check(
      "a new process correctly steals an expired lock instead of being blocked forever by a crashed holder",
      stolenAcquire === true,
    );
    const { data: rowAfterSteal } = await supabase.from("billing_action_locks").select("action").eq("account_id", accountId).single();
    check("the stolen lock row now reflects the new holder's action", rowAfterSteal?.action === "brand-addons/checkout", JSON.stringify(rowAfterSteal));

    await releaseBillingLock(accountId);
  } finally {
    await supabase.from("billing_action_locks").delete().eq("account_id", accountId);
    await supabase.auth.admin.deleteUser(accountId);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
