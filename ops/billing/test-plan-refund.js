// One-off smoke test — proves planRefund() correctly classifies requests
// against the published Refund Policy (lazyrelay.com/refunds) now that
// billing/MoR is live. No live Supabase/network calls needed since
// getMorStatus() only reads credentials and planRefund() takes no DB arg.
// Run: node ops/billing/test-plan-refund.js

const { planRefund } = require("./billing_ops.js");

async function main() {
  let pass = true;

  const errorCase = await planRefund(null, { reason: "I think I was charged twice this month" });
  if (errorCase.decision !== "escalate_for_manual_review") {
    console.error("FAIL: a duplicate-charge reason should escalate for manual review.", errorCase);
    pass = false;
  } else {
    console.log("PASS: billing-error reason correctly escalates for manual review.");
  }

  const changeOfMindCase = await planRefund(null, { reason: "I just don't want it anymore, please refund" });
  if (changeOfMindCase.decision !== "deny_per_policy") {
    console.error("FAIL: a change-of-mind reason should be denied per policy.", changeOfMindCase);
    pass = false;
  } else {
    console.log("PASS: change-of-mind reason correctly denied per policy.");
  }

  try {
    await planRefund(null, {});
    console.error("FAIL: planRefund should throw when no reason is given.");
    pass = false;
  } catch {
    console.log("PASS: planRefund throws on a missing reason instead of guessing.");
  }

  console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
