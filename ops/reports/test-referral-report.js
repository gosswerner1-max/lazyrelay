// Smoke test for the partner commission maths (see referral_report.js's own header). No live Supabase or network calls: the maths
// is pure functions exported for exactly this reason.
// Rules under test (Werner, 2026-10-22): commission is a percentage of the sale EXCLUDING tax, for 6 months from the customer's first
// paid purchase; when a subscription is cancelled, commission on THAT subscription stops with it. Pack (one-off) purchases count the
// same as subscription payments. The 30 day refund hold and refund netting are unchanged.
// Run: node ops/reports/test-referral-report.js

const { addMonths, rateForSale, netExTaxDollars, PLAN_PRESETS, COMMISSION_MONTHS, firstPaidPurchaseAt, accountCommission } = require("./referral_report.js");

function main() {
  let pass = true;

  function check(label, actual, expected) {
    const same = typeof expected === "number" && typeof actual === "number" ? Math.abs(actual - expected) < 1e-9 : actual === expected;
    if (!same) {
      console.error(`FAIL: ${label} — expected ${expected}, got ${actual}`);
      pass = false;
    } else {
      console.log(`PASS: ${label}`);
    }
  }

  const start = new Date("2026-01-15T00:00:00.000Z");
  const planA = { commission_rate_months_1_3: PLAN_PRESETS.A.commissionRateMonths1to3, commission_rate_months_4_12: PLAN_PRESETS.A.commissionRateMonths4to12 };
  const planB = { commission_rate_months_1_3: PLAN_PRESETS.B.commissionRateMonths1to3, commission_rate_months_4_12: PLAN_PRESETS.B.commissionRateMonths4to12 };

  check("the commission window is 6 months", COMMISSION_MONTHS, 6);

  // Plan A: 20% flat, 6 months.
  check("Plan A, first day, 20%", rateForSale(planA, start, start), 20);
  check("Plan A, 5 months in, still 20%", rateForSale(planA, start, addMonths(start, 5)), 20);
  check("Plan A, just under 6 months, still 20%", rateForSale(planA, start, new Date(addMonths(start, 6).getTime() - 1)), 20);
  check("Plan A, exactly 6 months in, the window has closed", rateForSale(planA, start, addMonths(start, 6)), null);
  check("Plan A, 9 months in, excluded (was inside the old 12 month window)", rateForSale(planA, start, addMonths(start, 9)), null);

  // Plan B keeps its own stored rates (not decided by Werner): only the end of the window moved to 6 months.
  check("Plan B, first day, 30%", rateForSale(planB, start, start), 30);
  check("Plan B, exactly 3 months in, drops to 20%", rateForSale(planB, start, addMonths(start, 3)), 20);
  check("Plan B, 5 months in, still 20%", rateForSale(planB, start, addMonths(start, 5)), 20);
  check("Plan B, exactly 6 months in, the window has closed", rateForSale(planB, start, addMonths(start, 6)), null);

  check("addMonths(2026-01-15, 1) lands on 2026-02-15", addMonths(new Date("2026-01-15T00:00:00.000Z"), 1).toISOString().slice(0, 10), "2026-02-15");
  check("addMonths(2026-01-31, 1) rolls into March (Feb has no 31st)", addMonths(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString().slice(0, 10), "2026-03-03");

  // Commission basis (decided 2026-10-01): dollars, excluding VAT, after discount. Minor units, total includes tax.
  check("real sale: total 5997 incl. 783 tax is $52.14 excluding tax", netExTaxDollars({ total: 5997, tax: 783 }), 52.14);
  check("100%-discounted sale earns nothing", netExTaxDollars({ total: 0, tax: 0 }), 0);
  check("string amounts from the database are handled", netExTaxDollars({ total: "2998", tax: "391" }), 26.07);

  // First paid purchase: the earliest sale that actually paid something.
  const sale = (id, iso, total, tax = 0, sub = null) => ({ paddle_transaction_id: id, paddle_subscription_id: sub, total, tax, occurred_at: iso });
  check("first paid purchase skips a 100% discounted sale", firstPaidPurchaseAt([sale("t0", "2026-01-10T00:00:00Z", 0), sale("t1", "2026-01-20T00:00:00Z", 1000), sale("t2", "2026-02-20T00:00:00Z", 1000)]).toISOString(), "2026-01-20T00:00:00.000Z");
  check("first paid purchase is null when nothing was ever paid", firstPaidPurchaseAt([sale("t0", "2026-01-10T00:00:00Z", 0)]), null);

  // accountCommission: the whole rule set on one referred account.
  const longAgo = new Date("2030-01-01T00:00:00Z"); // hold cutoff far in the future = every sale is past the 30 day hold
  const base = { partner: planA, redeemedAt: start, refundedByTransaction: new Map(), cancelledSubscriptions: new Map(), holdCutoff: longAgo };

  check(
    "a wallet pack (no subscription) earns 20% of the amount excluding tax",
    accountCommission({ ...base, sales: [sale("p1", "2026-01-15T00:00:00Z", 1150, 150)] }),
    1000 / 100 * 0.2,
  );
  check(
    "a pack bought in month 3 and a plan payment in month 5 both earn; one in month 6 does not",
    accountCommission({
      ...base,
      sales: [sale("p1", "2026-01-15T00:00:00Z", 1000), sale("p2", "2026-04-20T00:00:00Z", 1000), sale("s1", "2026-06-10T00:00:00Z", 2900, 0, "sub_1"), sale("s2", "2026-07-16T00:00:00Z", 2900, 0, "sub_1")],
    }),
    (1000 + 1000 + 2900) / 100 * 0.2,
  );
  check(
    "the window starts at the first PAID purchase, not at an earlier free one",
    accountCommission({ ...base, redeemedAt: new Date("2026-01-01T00:00:00Z"), sales: [sale("t0", "2026-01-02T00:00:00Z", 0), sale("t1", "2026-01-15T00:00:00Z", 1000), sale("t2", "2026-07-10T00:00:00Z", 1000)] }),
    1000 / 100 * 0.2 + 1000 / 100 * 0.2,
  );
  check(
    "a sale on a subscription cancelled before it stops earning; sales before the cancellation and a later pack still earn",
    accountCommission({
      ...base,
      cancelledSubscriptions: new Map([["sub_1", new Date("2026-03-01T00:00:00Z")]]),
      sales: [sale("s1", "2026-02-01T00:00:00Z", 2900, 0, "sub_1"), sale("s2", "2026-03-01T00:00:00Z", 2900, 0, "sub_1"), sale("s3", "2026-04-01T00:00:00Z", 2900, 0, "sub_1"), sale("p9", "2026-04-05T00:00:00Z", 1000)],
    }),
    (2900 + 1000) / 100 * 0.2,
  );
  check(
    "a different subscription is not stopped by another one's cancellation",
    accountCommission({
      ...base,
      cancelledSubscriptions: new Map([["sub_old", new Date("2026-02-01T00:00:00Z")]]),
      sales: [sale("s1", "2026-01-15T00:00:00Z", 2900, 0, "sub_new"), sale("s2", "2026-03-01T00:00:00Z", 2900, 0, "sub_new")],
    }),
    5800 / 100 * 0.2,
  );
  check(
    "a sale newer than the 30 day hold is left out of this run",
    accountCommission({ ...base, holdCutoff: new Date("2026-02-01T00:00:00Z"), sales: [sale("a", "2026-01-15T00:00:00Z", 1000), sale("b", "2026-02-10T00:00:00Z", 1000)] }),
    1000 / 100 * 0.2,
  );
  check(
    "a refund is netted off its own sale",
    accountCommission({ ...base, refundedByTransaction: new Map([["a", 4]]), sales: [sale("a", "2026-01-15T00:00:00Z", 1000)] }),
    (10 - 4) * 0.2,
  );
  check("a refund bigger than the sale never goes negative", accountCommission({ ...base, refundedByTransaction: new Map([["a", 99]]), sales: [sale("a", "2026-01-15T00:00:00Z", 1000)] }), 0);
  check("an account that never paid earns nothing", accountCommission({ ...base, sales: [sale("a", "2026-01-15T00:00:00Z", 0)] }), 0);
  check(
    "Plan B keeps 30% for 3 months then 20% (up to the 6 month end)",
    accountCommission({ ...base, partner: planB, sales: [sale("a", "2026-01-15T00:00:00Z", 1000), sale("b", "2026-05-01T00:00:00Z", 1000), sale("c", "2026-08-01T00:00:00Z", 1000)] }),
    10 * 0.3 + 10 * 0.2,
  );

  console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
  if (!pass) process.exit(1);
}

main();
