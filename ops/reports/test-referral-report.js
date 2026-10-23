// Smoke test for the partner commission maths (see referral_report.js's own header). No live Supabase or network calls: the maths
// is pure functions exported for exactly this reason.
// Rules under test (Werner, 2026-10-22 and 2026-10-23): ONE flat plan. The partner earns 20% of the sale EXCLUDING tax, for 6 months from
// the customer's first paid purchase. When a subscription is cancelled, commission on THAT subscription stops with it. A Pay as you go
// pack (a one-off sale, no subscription) pays the partner ONCE, on the customer's first paid purchase only; repeat packs pay nothing.
// Growth and Pro subscription payments pay every month inside the 6 months. The 30 day refund hold and refund netting are unchanged.
// The old per-partner rate columns (Plan A / Plan B) are ignored.
// Run: NODE_ENV=test node ops/reports/test-referral-report.js

const { addMonths, inWindow, netExTaxDollars, COMMISSION_MONTHS, COMMISSION_RATE, firstPaidSale, accountCommission } = require("./referral_report.js");

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

  check("the commission window is 6 months", COMMISSION_MONTHS, 6);
  check("the one flat rate is 20%", COMMISSION_RATE, 20);

  check("window: first day is inside", inWindow(start, start), true);
  check("window: 5 months in is inside", inWindow(start, addMonths(start, 5)), true);
  check("window: just under 6 months is inside", inWindow(start, new Date(addMonths(start, 6).getTime() - 1)), true);
  check("window: exactly 6 months in is closed", inWindow(start, addMonths(start, 6)), false);
  check("window: 9 months in is closed", inWindow(start, addMonths(start, 9)), false);

  check("addMonths(2026-01-15, 1) lands on 2026-02-15", addMonths(new Date("2026-01-15T00:00:00.000Z"), 1).toISOString().slice(0, 10), "2026-02-15");
  check("addMonths(2026-01-31, 1) rolls into March (Feb has no 31st)", addMonths(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString().slice(0, 10), "2026-03-03");

  // Commission basis (decided 2026-10-01): dollars, excluding VAT, after discount. Minor units, total includes tax.
  check("real sale: total 5997 incl. 783 tax is $52.14 excluding tax", netExTaxDollars({ total: 5997, tax: 783 }), 52.14);
  check("100%-discounted sale earns nothing", netExTaxDollars({ total: 0, tax: 0 }), 0);
  check("string amounts from the database are handled", netExTaxDollars({ total: "2998", tax: "391" }), 26.07);

  const sale = (id, iso, total, tax = 0, sub = null) => ({ paddle_transaction_id: id, paddle_subscription_id: sub, total, tax, occurred_at: iso });
  check("first paid sale skips a 100% discounted sale", firstPaidSale([sale("t0", "2026-01-10T00:00:00Z", 0), sale("t1", "2026-01-20T00:00:00Z", 1000), sale("t2", "2026-02-20T00:00:00Z", 1000)]).paddle_transaction_id, "t1");
  check("first paid sale is null when nothing was ever paid", firstPaidSale([sale("t0", "2026-01-10T00:00:00Z", 0)]), null);

  const longAgo = new Date("2030-01-01T00:00:00Z"); // every sale is past the 30 day hold
  const base = { redeemedAt: start, refundedByTransaction: new Map(), cancelledSubscriptions: new Map(), holdCutoff: longAgo };
  const pct = (dollars) => dollars * 0.2;

  // Pay as you go: once.
  check("a first pack pays 20% of the amount excluding tax", accountCommission({ ...base, sales: [sale("p1", "2026-01-15T00:00:00Z", 1150, 150)] }), pct(10));
  check(
    "repeat packs pay nothing: only the first paid purchase pays",
    accountCommission({ ...base, sales: [sale("p1", "2026-01-15T00:00:00Z", 1000), sale("p2", "2026-02-15T00:00:00Z", 5000), sale("p3", "2026-03-15T00:00:00Z", 5000)] }),
    pct(10),
  );
  check(
    "a pack bought AFTER a subscription started pays nothing (the first paid purchase was the subscription)",
    accountCommission({ ...base, sales: [sale("s1", "2026-01-15T00:00:00Z", 2900, 0, "sub_1"), sale("p9", "2026-02-01T00:00:00Z", 5000)] }),
    pct(29),
  );
  check(
    "a free first sale does not use up the once: the first PAID pack pays",
    accountCommission({ ...base, sales: [sale("t0", "2026-01-10T00:00:00Z", 0), sale("p1", "2026-01-20T00:00:00Z", 1000), sale("p2", "2026-02-20T00:00:00Z", 1000)] }),
    pct(10),
  );

  // Subscriptions: every month inside the window, until cancellation.
  check(
    "plan payments pay every month inside the 6 months, none from month 6",
    accountCommission({
      ...base,
      sales: [sale("s1", "2026-01-15T00:00:00Z", 2900, 0, "sub_1"), sale("s2", "2026-02-15T00:00:00Z", 2900, 0, "sub_1"), sale("s3", "2026-06-14T00:00:00Z", 2900, 0, "sub_1"), sale("s4", "2026-07-15T00:00:00Z", 2900, 0, "sub_1")],
    }),
    pct(29 * 3),
  );
  check(
    "the window starts at the first PAID purchase, not at an earlier free one",
    accountCommission({ ...base, redeemedAt: new Date("2026-01-01T00:00:00Z"), sales: [sale("t0", "2026-01-02T00:00:00Z", 0, 0, "sub_0"), sale("t1", "2026-01-15T00:00:00Z", 1000, 0, "sub_1"), sale("t2", "2026-07-10T00:00:00Z", 1000, 0, "sub_1")] }),
    pct(10) + pct(10),
  );
  check(
    "a sale on a subscription cancelled before it stops earning; sales before the cancellation still earn",
    accountCommission({
      ...base,
      cancelledSubscriptions: new Map([["sub_1", new Date("2026-03-01T00:00:00Z")]]),
      sales: [sale("s1", "2026-02-01T00:00:00Z", 2900, 0, "sub_1"), sale("s2", "2026-03-01T00:00:00Z", 2900, 0, "sub_1"), sale("s3", "2026-04-01T00:00:00Z", 2900, 0, "sub_1")],
    }),
    pct(29),
  );
  check(
    "another subscription is not stopped by a different one's cancellation",
    accountCommission({
      ...base,
      cancelledSubscriptions: new Map([["sub_old", new Date("2026-02-01T00:00:00Z")]]),
      sales: [sale("s1", "2026-01-15T00:00:00Z", 2900, 0, "sub_new"), sale("s2", "2026-03-01T00:00:00Z", 2900, 0, "sub_new")],
    }),
    pct(58),
  );

  // Hold and refunds unchanged.
  check(
    "a sale newer than the 30 day hold is left out of this run",
    accountCommission({ ...base, holdCutoff: new Date("2026-02-01T00:00:00Z"), sales: [sale("a", "2026-01-15T00:00:00Z", 1000, 0, "s"), sale("b", "2026-02-10T00:00:00Z", 1000, 0, "s")] }),
    pct(10),
  );
  check("a refund is netted off its own sale", accountCommission({ ...base, refundedByTransaction: new Map([["a", 4]]), sales: [sale("a", "2026-01-15T00:00:00Z", 1000)] }), pct(6));
  check("a refund bigger than the sale never goes negative", accountCommission({ ...base, refundedByTransaction: new Map([["a", 99]]), sales: [sale("a", "2026-01-15T00:00:00Z", 1000)] }), 0);
  check("an account that never paid earns nothing", accountCommission({ ...base, sales: [sale("a", "2026-01-15T00:00:00Z", 0)] }), 0);

  // Ignored columns: whatever per-partner rates the database still holds, the flat 20% is used.
  check(
    "old per-partner rate columns are ignored",
    accountCommission({ ...base, partner: { commission_rate_months_1_3: 30, commission_rate_months_4_12: 5 }, sales: [sale("a", "2026-01-15T00:00:00Z", 1000, 0, "s")] }),
    pct(10),
  );

  console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
  if (!pass) process.exit(1);
}

main();
