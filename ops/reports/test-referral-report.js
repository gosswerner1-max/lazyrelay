// One-off smoke test — proves rateForSale() correctly tiers/caps commission
// per referral program v2's real design (see referral_report.js's own
// header). No live Supabase/network calls needed: rateForSale and addMonths
// are pure functions, exported specifically so this test doesn't need one.
// Run: node ops/reports/test-referral-report.js

const { addMonths, rateForSale, PLAN_PRESETS } = require("./referral_report.js");

function main() {
  let pass = true;

  function check(label, actual, expected) {
    if (actual !== expected) {
      console.error(`FAIL: ${label} — expected ${expected}, got ${actual}`);
      pass = false;
    } else {
      console.log(`PASS: ${label}`);
    }
  }

  const redeemedAt = new Date("2026-01-15T00:00:00.000Z");
  const planA = { commission_rate_months_1_3: PLAN_PRESETS.A.commissionRateMonths1to3, commission_rate_months_4_12: PLAN_PRESETS.A.commissionRateMonths4to12 };
  const planB = { commission_rate_months_1_3: PLAN_PRESETS.B.commissionRateMonths1to3, commission_rate_months_4_12: PLAN_PRESETS.B.commissionRateMonths4to12 };

  // Plan A: flat 20% for all 12 months -- both tiers should read the same.
  check("Plan A, day of redemption, gets the early rate", rateForSale(planA, redeemedAt, redeemedAt), 20);
  check("Plan A, 1 month in, still the early rate (within the 3-month window)", rateForSale(planA, redeemedAt, addMonths(redeemedAt, 1)), 20);
  check("Plan A, 6 months in, still 20% (flat across both tiers)", rateForSale(planA, redeemedAt, addMonths(redeemedAt, 6)), 20);
  check("Plan A, exactly 12 months in, past the cap -- excluded", rateForSale(planA, redeemedAt, addMonths(redeemedAt, 12)), null);
  check("Plan A, 13 months in, excluded", rateForSale(planA, redeemedAt, addMonths(redeemedAt, 13)), null);

  // Plan B: 30% for months 1-3, drops to 20% for months 4-12, then excluded.
  check("Plan B, day of redemption, gets the early 30% rate", rateForSale(planB, redeemedAt, redeemedAt), 30);
  check("Plan B, just under 3 months in, still 30%", rateForSale(planB, redeemedAt, new Date(addMonths(redeemedAt, 3).getTime() - 1)), 30);
  check("Plan B, exactly 3 months in, drops to the late 20% rate", rateForSale(planB, redeemedAt, addMonths(redeemedAt, 3)), 20);
  check("Plan B, 9 months in, still 20% (within the 4-12 window)", rateForSale(planB, redeemedAt, addMonths(redeemedAt, 9)), 20);
  check("Plan B, exactly 12 months in, past the cap -- excluded", rateForSale(planB, redeemedAt, addMonths(redeemedAt, 12)), null);
  check("Plan B, 2 years in, excluded", rateForSale(planB, redeemedAt, addMonths(redeemedAt, 24)), null);

  // addMonths itself -- real calendar-month arithmetic, not a fixed-ms
  // approximation (which would drift across months of different lengths).
  check("addMonths(2026-01-15, 1) lands on 2026-02-15", addMonths(new Date("2026-01-15T00:00:00.000Z"), 1).toISOString().slice(0, 10), "2026-02-15");
  check("addMonths(2026-01-31, 1) rolls into March (Feb has no 31st)", addMonths(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString().slice(0, 10), "2026-03-03");

  console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
  if (!pass) process.exit(1);
}

main();
