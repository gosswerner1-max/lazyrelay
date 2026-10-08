#!/usr/bin/env node
// Referral/partner commission report — v2 (2026-09-29, Werner's design after
// real competitor benchmarking: the original flat 30% LIFETIME commission
// was a real outlier against every direct competitor's own published
// affiliate terms — see werner-brain vault, LazyRelay/Growth,
// project-seo-aeo-paid-search-launch.md's referral-program section, for the
// real sourced research behind this rewrite). Manual payout, no
// partner-facing dashboard — this script is still the only interface to the
// program.
//
// Two partner structures now exist, chosen per-partner at --add-partner time:
//   Option A (givesViewerDiscount=true): the partner's own code is ALSO a
//     real Paddle discount (Werner creates that separately, in Paddle's own
//     dashboard, using the SAME code string) -- their referred customers get
//     10% off their first 3 months. Partner commission: flat 20% for the
//     first 12 months.
//   Option B (givesViewerDiscount=false): no viewer discount, no Paddle
//     discount object needed at all -- the partner earns more instead,
//     front-loaded: 30% for the first 3 months, 20% for months 4-12.
// Both cap at 12 months total from partner_code_redeemed_at, replacing v1's
// open-ended lifetime commission.
//
// Attribution source also changed: v1 credited a partner the moment someone
// signed up via their ?ref= link (accounts.referred_by_code, set at signup,
// independent of whether that person ever paid). v2 only credits a partner
// once their code is actually redeemed AT CHECKOUT on a real, paying
// subscription (accounts.partner_code_redeemed / _at, set by
// backend/src/billing/sync.ts's recordPartnerAttribution on a genuinely
// first-ever subscription webhook) -- a partner only gets paid for
// conversions they demonstrably drove, not just clicks. The old
// referred_by_code/referred_at columns (migration 0079) still exist and are
// left untouched, but this report no longer reads them.
//
// Run: node referral_report.js
//   Shows commission owed per approved partner (capped at 12 months per
//   referred account, tiered per Option A/B), minus whatever's already been
//   recorded as paid.
//
// Run: node referral_report.js --mark-paid <code> <amount>
//   Records a manual payout against a partner's running total. This is the
//   ONLY thing that should ever increment total_paid_out — never edit it by
//   hand in Supabase, or this report will double- or under-count next time.
//
// Run: node referral_report.js --add-partner <code> <name> <email> <A|B>
//   Creates a new approved partner. A = 20% for 12 months, viewer gets 10%
//   off their first 3 months (Werner must also create a matching Paddle
//   discount with this exact code -- percentage 10, recur,
//   maximum_recurring_intervals 3). B = 30% for 3 months then 20% for
//   9 more, no viewer discount, no Paddle discount object needed. There's no
//   self-serve application — Werner invites people by hand.
//
// Commission math, per partner, per referred real account (excluding
// internal test accounts):
//   For each 'sale' older than the 30-day refund hold, minus any matching
//   refund, commission = that net sale amount × whichever tier rate applies
//   to how long after partner_code_redeemed_at the sale occurred (months
//   0-3: the early rate; months 3-12: the late rate; 12+: excluded
//   entirely, the partner's window has closed). A sale newer than 30 days is
//   excluded from this run entirely, not partially counted — it reappears
//   once it clears the hold, same as v1's payout-hold rule.

const { getSupabaseClient } = require("../shared/supabaseClient.js");
const { isInternalTestAccount } = require("../shared/internalTestAccounts.js");
const { generatePartnerCode, buildReferralUrl, isPaddleSafe } = require("../shared/referralLinks.js");

const REFUND_HOLD_MS = 30 * 24 * 60 * 60 * 1000;

const PLAN_PRESETS = {
  A: { givesViewerDiscount: true, commissionRateMonths1to3: 20, commissionRateMonths4to12: 20 },
  B: { givesViewerDiscount: false, commissionRateMonths1to3: 30, commissionRateMonths4to12: 20 },
};

/** What a billing record is worth for commission, in dollars: the amount the
 *  customer actually paid or got back, EXCLUDING VAT/sales tax, after any
 *  discount. Decided 2026-10-01 (Werner). billing_records stores Paddle's
 *  minor units as-is (5214 means $52.14), and `total` includes tax, so this is
 *  (total - tax) / 100. A sale's `subtotal` is NOT usable: it is the list price
 *  before discount (a 100%-discounted sale has subtotal 870 and total 0). */
function netExTaxDollars(row) {
  return (Number(row.total) - Number(row.tax)) / 100;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** Which tier rate applies to a sale, given how long after the account's own
 *  redemption date it landed. Returns null past the 12-month cap -- that
 *  sale earns the partner nothing, the window has closed. */
function rateForSale(partner, redeemedAt, saleDate) {
  const threeMonthCutoff = addMonths(redeemedAt, 3);
  const twelveMonthCutoff = addMonths(redeemedAt, 12);
  if (saleDate >= twelveMonthCutoff) return null;
  if (saleDate >= threeMonthCutoff) return Number(partner.commission_rate_months_4_12);
  return Number(partner.commission_rate_months_1_3);
}

async function computePartnerCommission(supabase, partner) {
  const { data: referredAccounts, error: accountsError } = await supabase
    .from("accounts")
    .select("id, email, partner_code_redeemed_at")
    .eq("partner_code_redeemed", partner.code);
  if (accountsError) throw new Error(`accounts lookup for ${partner.code}: ${accountsError.message}`);

  const realAccounts = (referredAccounts ?? []).filter((a) => !isInternalTestAccount(a.email) && a.partner_code_redeemed_at);
  if (realAccounts.length === 0) {
    return { partner, referredAccountCount: 0, lifetimeCommission: 0, owedNow: 0 };
  }

  const accountIds = realAccounts.map((a) => a.id);
  const redeemedAtByAccount = new Map(realAccounts.map((a) => [a.id, new Date(a.partner_code_redeemed_at)]));
  const holdCutoff = new Date(Date.now() - REFUND_HOLD_MS).toISOString();

  const { data: sales, error: salesError } = await supabase
    .from("billing_records")
    .select("id, account_id, paddle_transaction_id, total, tax, occurred_at")
    .in("account_id", accountIds)
    .eq("kind", "sale")
    .lt("occurred_at", holdCutoff);
  if (salesError) throw new Error(`sales lookup for ${partner.code}: ${salesError.message}`);

  const { data: refunds, error: refundsError } = await supabase
    .from("billing_records")
    .select("paddle_transaction_id, total, tax")
    .in("account_id", accountIds)
    .eq("kind", "refund");
  if (refundsError) throw new Error(`refunds lookup for ${partner.code}: ${refundsError.message}`);

  const refundedTotalByTransaction = new Map();
  for (const refund of refunds ?? []) {
    const prior = refundedTotalByTransaction.get(refund.paddle_transaction_id) ?? 0;
    refundedTotalByTransaction.set(refund.paddle_transaction_id, prior + netExTaxDollars(refund));
  }

  let commission = 0;
  for (const sale of sales ?? []) {
    const redeemedAt = redeemedAtByAccount.get(sale.account_id);
    if (!redeemedAt) continue; // shouldn't happen, accountIds came from realAccounts -- defensive only
    const refunded = refundedTotalByTransaction.get(sale.paddle_transaction_id) ?? 0;
    const netSaleAmount = Math.max(0, netExTaxDollars(sale) - refunded);
    const rate = rateForSale(partner, redeemedAt, new Date(sale.occurred_at));
    if (rate === null) continue; // past the 12-month window for this account
    commission += netSaleAmount * (rate / 100);
  }

  const owedNow = Math.max(0, commission - Number(partner.total_paid_out));
  return { partner, referredAccountCount: realAccounts.length, lifetimeCommission: commission, owedNow };
}

// Link opens in the last 30 days, from the anonymous counter (migration 0118). Returns null if the counter does not exist yet.
async function clicksLast30Days(supabase, code) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from("referral_click_counts").select("clicks").eq("code", code).gte("day", since);
  if (error) return null;
  return (data ?? []).reduce((sum, r) => sum + Number(r.clicks), 0);
}

async function runReport(supabase) {
  const { data: partners, error } = await supabase.from("referral_partners").select("*").eq("status", "approved");
  if (error) throw new Error(`referral_partners lookup: ${error.message}`);

  if (!partners || partners.length === 0) {
    console.log("No approved referral partners yet.");
    return;
  }

  console.log(`Referral commission report — ${new Date().toISOString().slice(0, 10)}\n`);
  for (const partner of partners) {
    const result = await computePartnerCommission(supabase, partner);
    const plan = partner.gives_viewer_discount ? "A (viewer discount)" : "B (no viewer discount)";
    console.log(`${partner.name} (${partner.code}) — ${partner.email} — Plan ${plan}`);
    console.log(`  Rate: ${partner.commission_rate_months_1_3}% months 1-3, ${partner.commission_rate_months_4_12}% months 4-12, capped at 12 months`);
    const clicks = await clicksLast30Days(supabase, partner.code);
    console.log(`  Link opens, last 30 days: ${clicks === null ? "not available yet" : clicks}`);
    console.log(`  Referred accounts (real, code-redeemed): ${result.referredAccountCount}`);
    console.log(`  Commission earned so far: $${result.lifetimeCommission.toFixed(2)}`);
    console.log(`  Already paid out: $${Number(partner.total_paid_out).toFixed(2)}`);
    console.log(`  Owed now: $${result.owedNow.toFixed(2)}\n`);
  }
}

async function markPaid(supabase, code, amountStr) {
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`--mark-paid amount must be a positive number, got: ${amountStr}`);
  }
  const { data: partner, error: fetchError } = await supabase
    .from("referral_partners")
    .select("id, name, total_paid_out")
    .eq("code", code)
    .maybeSingle();
  if (fetchError) throw new Error(`partner lookup for ${code}: ${fetchError.message}`);
  if (!partner) throw new Error(`No referral partner with code "${code}"`);

  const newTotal = Number(partner.total_paid_out) + amount;
  const { error: updateError } = await supabase.from("referral_partners").update({ total_paid_out: newTotal }).eq("id", partner.id);
  if (updateError) throw new Error(`recording payout for ${code}: ${updateError.message}`);

  console.log(`Recorded $${amount.toFixed(2)} paid to ${partner.name} (${code}). New lifetime total paid: $${newTotal.toFixed(2)}.`);
}

async function addPartner(supabase, code, name, email, planStr) {
  const plan = (planStr ?? "").trim().toUpperCase();
  const preset = PLAN_PRESETS[plan];
  if (!preset) {
    throw new Error(`plan must be "A" (20%/12mo, 10% viewer discount) or "B" (30%/3mo then 20%/9mo, no viewer discount), got: "${planStr}"`);
  }
  // code "auto" (added 2026-10-08): make a unique code from the partner's name instead of typing one.
  let normalizedCode;
  if (code.trim().toLowerCase() === "auto") {
    const { data: existing, error: listError } = await supabase.from("referral_partners").select("code");
    if (listError) throw new Error(`reading existing partner codes: ${listError.message}`);
    const taken = new Set((existing ?? []).map((r) => String(r.code).toLowerCase()));
    normalizedCode = generatePartnerCode(name, (c) => taken.has(c));
  } else {
    normalizedCode = code.trim().toLowerCase();
  }
  if (!/^[a-z0-9-]{3,40}$/.test(normalizedCode)) {
    throw new Error(`code must be 3-40 lowercase letters/digits/hyphens, got: "${code}"`);
  }
  // Plan A codes are also Paddle discount codes, and Paddle accepts letters and numbers only (checked 2026-10-08).
  if (preset.givesViewerDiscount && !isPaddleSafe(normalizedCode)) {
    throw new Error(`Plan A code "${normalizedCode}" cannot be a Paddle discount code (letters and numbers only, up to 32). Use a code without hyphens, or "auto".`);
  }

  const { error } = await supabase.from("referral_partners").insert({
    code: normalizedCode,
    name,
    email,
    gives_viewer_discount: preset.givesViewerDiscount,
    commission_rate_months_1_3: preset.commissionRateMonths1to3,
    commission_rate_months_4_12: preset.commissionRateMonths4to12,
  });
  if (error) throw new Error(`creating partner "${normalizedCode}": ${error.message}`);

  console.log(`Created partner "${name}" — code "${normalizedCode}", Plan ${plan}.`);
  if (preset.givesViewerDiscount) {
    console.log(`REMINDER: create a matching Paddle discount now — code "${normalizedCode}", 10% off, recurring, maximum_recurring_intervals 3.`);
    console.log(`Send them either: "use code ${normalizedCode} at checkout" or this link: ${buildReferralUrl({ code: normalizedCode, plan })}`);
  } else {
    console.log(`No Paddle discount needed for Plan B. Send them: ${buildReferralUrl({ code: normalizedCode, plan })}`);
  }
  console.log(`Per-channel link (add a place name so you can tell where clicks come from): ${buildReferralUrl({ code: normalizedCode, plan, channel: "youtube" })}`);
}

// Exported for ops/reports/test-referral-report.js — the real tiering/cutoff
// math, without needing a live Supabase connection to exercise it.
module.exports = { addMonths, rateForSale, netExTaxDollars, PLAN_PRESETS, addPartner };

async function main() {
  const supabase = getSupabaseClient();
  const args = process.argv.slice(2);
  if (args[0] === "--mark-paid") {
    const [, code, amount] = args;
    if (!code || !amount) {
      console.error("Usage: node referral_report.js --mark-paid <code> <amount>");
      process.exit(1);
    }
    await markPaid(supabase, code, amount);
    return;
  }
  if (args[0] === "--add-partner") {
    const [, code, name, email, plan] = args;
    if (!code || !name || !email || !plan) {
      console.error('Usage: node referral_report.js --add-partner <code|auto> <name> <email> <A|B>   ("auto" makes a unique code from the name)');
      process.exit(1);
    }
    await addPartner(supabase, code, name, email, plan);
    return;
  }
  await runReport(supabase);
}

// Guarded so ops/reports/test-referral-report.js can require() this file
// for its pure exports (above) without also triggering a real Supabase
// connection attempt -- main() only actually runs when this file is invoked
// directly as a CLI script.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
