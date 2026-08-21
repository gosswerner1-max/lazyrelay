import "dotenv/config"; // scheduler.ts imports supabase.ts at module load, which requires these even though this test never queries the DB
import { isRateLimited, DEFAULT_MAX_CALLS_PER_WINDOW } from "./scheduler.js";

// One-off manual smoke test for the proactive rate limiter added to
// scheduler.ts 2026-08-21 (a real gap found during a scaling review --
// the circuit breaker only reacts after failures, this caps calls per
// platform per window before a burst can approach a platform's own
// rate ceiling). Pure, fast, no database -- runSchedulerCycle's own
// CLAIM_BATCH_SIZE batching would tangle an exact-count assertion with a
// different mechanism entirely, so this tests isRateLimited() directly
// instead. Run: npx tsx src/test-rate-limiter.ts

function main() {
  let pass = true;
  // A platform name no other test/adapter uses, so this run's calls can't
  // collide with state left behind by test-reliability.ts's "meta" tests
  // if both happen to run in the same process (they don't currently, but
  // cheap insurance).
  const platform = "test-rate-limit-platform";

  console.log(`=== Exactly DEFAULT_MAX_CALLS_PER_WINDOW (${DEFAULT_MAX_CALLS_PER_WINDOW}) calls should be allowed ===`);
  let allowedCount = 0;
  for (let i = 0; i < DEFAULT_MAX_CALLS_PER_WINDOW; i++) {
    if (!isRateLimited(platform)) allowedCount++;
  }
  console.log(`${allowedCount}/${DEFAULT_MAX_CALLS_PER_WINDOW} allowed.`);
  if (allowedCount !== DEFAULT_MAX_CALLS_PER_WINDOW) {
    console.error(`FAIL: expected all ${DEFAULT_MAX_CALLS_PER_WINDOW} calls in the budget to be allowed.`);
    pass = false;
  } else {
    console.log("PASS: every call within budget was allowed.");
  }

  console.log(`\n=== Call number ${DEFAULT_MAX_CALLS_PER_WINDOW + 1} in the same window should be rejected ===`);
  const overBudget = isRateLimited(platform);
  console.log(`isRateLimited returned: ${overBudget}`);
  if (!overBudget) {
    console.error("FAIL: expected the call over budget to be rejected (isRateLimited should return true).");
    pass = false;
  } else {
    console.log("PASS: the over-budget call was correctly rejected.");
  }

  console.log("\n=== A different platform has its own independent budget ===");
  const otherPlatform = "test-rate-limit-platform-2";
  const otherAllowed = !isRateLimited(otherPlatform);
  console.log(`First call on a different platform allowed: ${otherAllowed}`);
  if (!otherAllowed) {
    console.error("FAIL: a fresh platform should not be affected by another platform's exhausted budget.");
    pass = false;
  } else {
    console.log("PASS: rate limits are scoped per platform, not global.");
  }

  console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
  process.exit(pass ? 0 : 1);
}

main();
