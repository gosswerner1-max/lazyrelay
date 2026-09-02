#!/usr/bin/env node
// Referral/partner commission report — v1 (Werner's build-vs-buy call,
// 2026-09-02: build in-house). Manual payout, no partner-facing dashboard —
// this script is the only interface to the program right now. See
// werner-brain vault, project-referral-program-spec-2026-09-02.md, for the
// full mechanics.
//
// Run: node referral_report.js
//   Shows lifetime commission owed per approved partner, minus whatever's
//   already been recorded as paid.
//
// Run: node referral_report.js --mark-paid <code> <amount>
//   Records a manual payout against a partner's running total. This is the
//   ONLY thing that should ever increment total_paid_out — never edit it by
//   hand in Supabase, or this report will double- or under-count next time.
//
// Run: node referral_report.js --add-partner <code> <name> <email> [commissionRate]
//   Creates a new approved partner (there's no self-serve application in
//   v1 — Werner invites people by hand, then sends them
//   lazyrelay.com/?ref=<code>). commissionRate defaults to 30 (percent).
//
// Commission math, per partner, across every account with referred_by_code
// matching their code (excluding internal test accounts):
//   lifetime commission = 30% (or the partner's own commission_rate) of
//   (sum of 'sale' totals older than the 30-day refund hold) minus (sum of
//   'refund' totals for those same sales, whenever they landed).
// A sale newer than 30 days is excluded entirely from this run, not
// partially counted — it reappears in a later run once it clears the hold,
// same as the spec's "30-day payout hold" rule.

const { getSupabaseClient } = require("../shared/supabaseClient.js");
const { isInternalTestAccount } = require("../shared/internalTestAccounts.js");

const REFUND_HOLD_MS = 30 * 24 * 60 * 60 * 1000;

async function computePartnerCommission(supabase, partner) {
  const { data: referredAccounts, error: accountsError } = await supabase
    .from("accounts")
    .select("id, email")
    .eq("referred_by_code", partner.code);
  if (accountsError) throw new Error(`accounts lookup for ${partner.code}: ${accountsError.message}`);

  const realAccounts = (referredAccounts ?? []).filter((a) => !isInternalTestAccount(a.email));
  if (realAccounts.length === 0) {
    return { partner, referredAccountCount: 0, lifetimeCommission: 0, owedNow: 0 };
  }

  const accountIds = realAccounts.map((a) => a.id);
  const holdCutoff = new Date(Date.now() - REFUND_HOLD_MS).toISOString();

  const { data: sales, error: salesError } = await supabase
    .from("billing_records")
    .select("id, paddle_transaction_id, total, occurred_at")
    .in("account_id", accountIds)
    .eq("kind", "sale")
    .lt("occurred_at", holdCutoff);
  if (salesError) throw new Error(`sales lookup for ${partner.code}: ${salesError.message}`);

  const { data: refunds, error: refundsError } = await supabase
    .from("billing_records")
    .select("paddle_transaction_id, total")
    .in("account_id", accountIds)
    .eq("kind", "refund");
  if (refundsError) throw new Error(`refunds lookup for ${partner.code}: ${refundsError.message}`);

  const refundedTotalByTransaction = new Map();
  for (const refund of refunds ?? []) {
    const prior = refundedTotalByTransaction.get(refund.paddle_transaction_id) ?? 0;
    refundedTotalByTransaction.set(refund.paddle_transaction_id, prior + Number(refund.total));
  }

  let netRevenue = 0;
  for (const sale of sales ?? []) {
    const refunded = refundedTotalByTransaction.get(sale.paddle_transaction_id) ?? 0;
    netRevenue += Math.max(0, Number(sale.total) - refunded);
  }

  const lifetimeCommission = netRevenue * (Number(partner.commission_rate) / 100);
  const owedNow = Math.max(0, lifetimeCommission - Number(partner.total_paid_out));
  return { partner, referredAccountCount: realAccounts.length, lifetimeCommission, owedNow };
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
    console.log(`  Referred accounts (real, past the free-tier tag): ${result.referredAccountCount}`);
    console.log(`  Lifetime commission earned: $${result.lifetimeCommission.toFixed(2)}`);
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

async function addPartner(supabase, code, name, email, commissionRateStr) {
  const normalizedCode = code.trim().toLowerCase();
  if (!/^[a-z0-9-]{3,40}$/.test(normalizedCode)) {
    throw new Error(`code must be 3-40 lowercase letters/digits/hyphens, got: "${code}"`);
  }
  const commissionRate = commissionRateStr !== undefined ? Number(commissionRateStr) : 30;
  if (!Number.isFinite(commissionRate) || commissionRate <= 0 || commissionRate > 100) {
    throw new Error(`commissionRate must be between 0 and 100, got: ${commissionRateStr}`);
  }
  const { error } = await supabase
    .from("referral_partners")
    .insert({ code: normalizedCode, name, email, commission_rate: commissionRate });
  if (error) throw new Error(`creating partner "${normalizedCode}": ${error.message}`);

  console.log(`Created partner "${name}" — code "${normalizedCode}", ${commissionRate}% commission.`);
  console.log(`Send them: https://lazyrelay.com/?ref=${normalizedCode}`);
}

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
    const [, code, name, email, commissionRate] = args;
    if (!code || !name || !email) {
      console.error("Usage: node referral_report.js --add-partner <code> <name> <email> [commissionRate]");
      process.exit(1);
    }
    await addPartner(supabase, code, name, email, commissionRate);
    return;
  }
  await runReport(supabase);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
