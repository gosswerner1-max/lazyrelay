#!/usr/bin/env node
// Referral/partner commission report. Manual payout, no partner-facing dashboard: this script is the only interface to the program.
//
// ONE flat plan (Werner, 2026-10-23; the earlier Plan A / Plan B split is gone):
//   - The partner earns 20% of the sale EXCLUDING tax, for 6 months from the customer's FIRST PAID purchase.
//   - A Growth or Pro subscription payment earns 20% every month inside those 6 months, until the subscription is cancelled (accrual on
//     that subscription stops at the cancellation date; nothing after it).
//   - A Pay as you go pack (a one-off sale with no subscription) earns 20% ONCE, and only when it is the customer's first paid purchase.
//     Repeat packs earn nothing. A pack bought after a subscription started earns nothing (the subscription was the first purchase).
//   - The customer's viewer discount (10% off the first month of Growth or Pro) is one shared Paddle discount applied by the server at
//     checkout; it is not a per-partner Paddle code and is not handled here.
// The old per-partner rate columns in referral_partners (gives_viewer_discount, commission_rate_months_1_3, commission_rate_months_4_12)
// still exist in the database but are IGNORED by this report. The 30 day refund hold and refund netting are unchanged.
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
//   Shows commission owed per approved partner (20% for 6 months from each
//   referred account's first paid purchase), minus whatever's already been
//   recorded as paid.
//
// Run: node referral_report.js --mark-paid <code> <amount>
//   Records a manual payout against a partner's running total. This is the
//   ONLY thing that should ever increment total_paid_out — never edit it by
//   hand in Supabase, or this report will double- or under-count next time.
//
// Run: node referral_report.js --add-partner <code|auto> <name> <email>
//   Creates a new approved partner (one plan). The email is also used to stop a partner earning on their own
//   purchase, so it must be the email of their LazyRelay account if they have one. There's no self-serve
//   application: Werner invites people by hand.
//
// Commission math, per partner, per referred real account (excluding
// internal test accounts): for each 'sale' older than the 30-day refund hold,
// minus any matching refund, commission = that net sale amount (excluding tax)
// x 20%, if the sale falls inside the 6 months after the account's first PAID
// purchase and the pack-once and cancellation rules above allow it. Wallet
// packs and plan payments are both 'sale' rows in billing_records. A sale newer
// than 30 days is excluded from this run entirely, not partially counted: it
// reappears once it clears the hold.

const { getSupabaseClient } = require("../shared/supabaseClient.js");
const { isInternalTestAccount } = require("../shared/internalTestAccounts.js");
const { generatePartnerCode, buildReferralUrl } = require("../shared/referralLinks.js");

const REFUND_HOLD_MS = 30 * 24 * 60 * 60 * 1000;
/** The one flat commission rate, in percent (Werner, 2026-10-23). */
const COMMISSION_RATE = 20;
/** How long after a customer's first paid purchase a partner earns commission (Werner, 2026-10-22). */
const COMMISSION_MONTHS = 6;


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

/** True while a sale is inside the 6 month window that starts at the customer's first paid purchase. */
function inWindow(windowStart, saleDate) {
  return saleDate < addMonths(windowStart, COMMISSION_MONTHS);
}

/** The earliest sale that actually paid something (tax excluded), or null if none did. A 100%-discounted sale is not a paid purchase.
 *  Its date is the start of the 6 month window, and a pack only earns when it is this sale. */
function firstPaidSale(sales) {
  let first = null;
  for (const sale of sales) {
    if (netExTaxDollars(sale) <= 0) continue;
    if (first === null || new Date(sale.occurred_at) < new Date(first.occurred_at)) first = sale;
  }
  return first;
}

/** Commission for one referred account, in dollars. Pure: no database. sales = every 'sale' row of the account (the hold is applied
 *  here, so the window start can still come from a sale inside the hold). refundedByTransaction = Map of transaction id to refunded
 *  dollars. cancelledSubscriptions = Map of subscription id to the date it was cancelled. */
function accountCommission({ redeemedAt, sales, refundedByTransaction, cancelledSubscriptions, holdCutoff }) {
  const firstPaid = firstPaidSale(sales);
  const windowStart = firstPaid ? new Date(firstPaid.occurred_at) : redeemedAt;
  let commission = 0;
  for (const sale of sales) {
    const saleDate = new Date(sale.occurred_at);
    if (saleDate >= holdCutoff) continue; // still inside the 30 day refund hold
    if (!inWindow(windowStart, saleDate)) continue; // past the 6 month window for this account
    const isPack = !sale.paddle_subscription_id;
    if (isPack && sale !== firstPaid) continue; // Pay as you go pays once: only when the pack IS the first paid purchase
    const cancelledAt = sale.paddle_subscription_id ? cancelledSubscriptions.get(sale.paddle_subscription_id) : undefined;
    if (cancelledAt && saleDate >= cancelledAt) continue; // that subscription was cancelled: accrual on it stopped
    const refunded = refundedByTransaction.get(sale.paddle_transaction_id) ?? 0;
    commission += Math.max(0, netExTaxDollars(sale) - refunded) * (COMMISSION_RATE / 100);
  }
  return commission;
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
  const holdCutoff = new Date(Date.now() - REFUND_HOLD_MS);

  // Every sale (wallet packs and plan payments as well as the old tier checkout), NOT only those past the hold: the 6 month window
  // starts at the first paid purchase, which may still be inside the hold. The hold itself is applied in accountCommission.
  const { data: sales, error: salesError } = await supabase
    .from("billing_records")
    .select("id, account_id, paddle_transaction_id, paddle_subscription_id, total, tax, occurred_at")
    .in("account_id", accountIds)
    .eq("kind", "sale");
  if (salesError) throw new Error(`sales lookup for ${partner.code}: ${salesError.message}`);

  // A cancelled subscription stops earning from the moment Paddle told us it was cancelled (the last webhook time of its row).
  const { data: subs, error: subsError } = await supabase
    .from("subscriptions")
    .select("account_id, mor_subscription_id, status, last_webhook_occurred_at, updated_at")
    .in("account_id", accountIds)
    .eq("status", "cancelled");
  if (subsError) throw new Error(`subscriptions lookup for ${partner.code}: ${subsError.message}`);
  const cancelledSubscriptions = new Map((subs ?? []).map((s) => [s.mor_subscription_id, new Date(s.last_webhook_occurred_at ?? s.updated_at)]));

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

  const salesByAccount = new Map();
  for (const sale of sales ?? []) {
    const list = salesByAccount.get(sale.account_id) ?? [];
    list.push(sale);
    salesByAccount.set(sale.account_id, list);
  }
  let commission = 0;
  for (const [accountId, redeemedAt] of redeemedAtByAccount) {
    commission += accountCommission({ redeemedAt, sales: salesByAccount.get(accountId) ?? [], refundedByTransaction: refundedTotalByTransaction, cancelledSubscriptions, holdCutoff });
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
    console.log(`${partner.name} (${partner.code}) — ${partner.email}`);
    console.log(`  Rate: ${COMMISSION_RATE}% of the sale excluding tax, for ${COMMISSION_MONTHS} months from the customer's first paid purchase; a pack pays once; stops when their subscription is cancelled`);
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

async function addPartner(supabase, code, name, email) {
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

  // Only code, name and email are written: the old per-partner rate columns keep their database defaults and are ignored by the report.
  const { error } = await supabase.from("referral_partners").insert({ code: normalizedCode, name, email });
  if (error) throw new Error(`creating partner "${normalizedCode}": ${error.message}`);

  console.log(`Created partner "${name}" — code "${normalizedCode}".`);
  console.log(`Send them this link: ${buildReferralUrl({ code: normalizedCode })}`);
  console.log(`Per-channel link (add a place name so you can tell where clicks come from): ${buildReferralUrl({ code: normalizedCode, channel: "youtube" })}`);
  console.log("They can also tell their audience to type the code at the payment screen. Their viewers get 10% off the first month of Growth or Pro through the shared Paddle discount (nothing to create per partner).");
}

// Exported for ops/reports/test-referral-report.js — the real tiering/window/cancellation
// math, without needing a live Supabase connection to exercise it.
module.exports = { addMonths, inWindow, netExTaxDollars, addPartner, COMMISSION_MONTHS, COMMISSION_RATE, firstPaidSale, accountCommission };

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
    const [, code, name, email] = args;
    if (!code || !name || !email) {
      console.error('Usage: node referral_report.js --add-partner <code|auto> <name> <email>   ("auto" makes a unique code from the name)');
      process.exit(1);
    }
    await addPartner(supabase, code, name, email);
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
