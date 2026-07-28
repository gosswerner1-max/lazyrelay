// Billing Operator — owns pure money events: subscription tier, payment
// status, dunning follow-up, refunds. Built against the existing
// MerchantOfRecordAdapter interface (backend/src/billing/types.ts),
// targeting Stripe Managed Payments per this session's research — see
// BILLING_KNOWLEDGE.md for why. Does NOT touch account state (pausing
// posts, connected-account limits) — that's accounts_ops.js's job.
//
// This module does NOT re-implement webhook sync — that's already real
// app code in backend/src/billing/sync.ts (syncSubscriptionFromWebhook).
// This is the monitoring/follow-up layer on top of what already lands in
// the DB via that real flow.

const { getMorCredentials } = require("../config/credentials.js");

const PAST_DUE_GRACE_HOURS = 24; // money-impacting -> tight loop, same
// reasoning as Lazy Download's vendor-issue follow-up policy (24h for
// money-impacting issues vs 1-2 days for standard ones).

/** `live` only ever meant "credentials are present," not "this is real
 * production billing" — confirmed 2026-07-28 that backend/.env still holds a
 * Paddle SANDBOX key with `PADDLE_ENVIRONMENT` unset, so the daily billing
 * task was reporting sandbox test data as if it were real customer
 * dunning/refund candidates with no way to tell from the output. `environment`
 * mirrors the exact same check `backend/src/index.ts` uses to construct the
 * real PaddleMorAdapter (`PADDLE_ENVIRONMENT === "production"` → production,
 * else sandbox) — same source of truth as the actual running adapter, not a
 * separate guess from the key's naming convention. Callers (the SKILL.md
 * report) must treat `environment !== "production"` as "don't act on these
 * candidates as real," not just log them quietly. */
function getMorStatus() {
  const creds = getMorCredentials();
  if (!creds) return { live: false, environment: "none" };
  const environment = process.env.PADDLE_ENVIRONMENT === "production" ? "production" : "sandbox";
  return { live: true, environment };
}

/** Subscriptions stuck in past_due for longer than the grace period —
 * real dunning-follow-up candidates. Requires the MoR to actually be live;
 * reports that honestly rather than returning a misleading empty list. */
async function findPastDueNeedingFollowup(supabase, graceHours = PAST_DUE_GRACE_HOURS) {
  const { live, environment } = getMorStatus();
  if (!live) {
    return { handled: false, reason: "no billing/MoR live yet — nothing to follow up on", environment, candidates: [] };
  }
  const cutoff = new Date(Date.now() - graceHours * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("subscriptions")
    .select("id, account_id, tier, status, updated_at")
    .eq("status", "past_due")
    .lt("updated_at", cutoff);
  if (error) throw error;
  const reason =
    environment === "production"
      ? "ok"
      : `ok, but MoR is in ${environment} mode — these are NOT real customers, do not act on them as real dunning candidates`;
  return { handled: true, reason, environment, candidates: data ?? [] };
}

/** Refund handling per the now-published Refund Policy (lazyrelay.com/refunds,
 * live as of 2026-07-23): no refunds for partial billing periods or
 * change-of-mind; suspected billing errors (duplicate charge, wrong amount)
 * are reviewed individually, not auto-approved. This function only
 * CLASSIFIES a request against that written policy — it never issues an
 * actual refund itself. Moving real money is a manual action taken directly
 * in the Paddle dashboard, not something ops code executes unattended.
 */
async function planRefund(supabase, refundRequest) {
  const { live } = getMorStatus();
  if (!live) {
    return { handled: false, reason: "no billing live yet — LazyRelay is free during testing, nothing to refund" };
  }
  if (!refundRequest || typeof refundRequest.reason !== "string" || !refundRequest.reason.trim()) {
    throw new Error("planRefund requires a refundRequest with a non-empty reason");
  }

  const looksLikeBillingError = /duplicate|charged twice|wrong amount|billing error|overcharg/i.test(refundRequest.reason);

  if (looksLikeBillingError) {
    return {
      handled: true,
      decision: "escalate_for_manual_review",
      policyBasis: "Exceptions section of https://lazyrelay.com/refunds — billing errors reviewed individually, not auto-refunded",
      customerMessage:
        "We're looking into this billing issue and will follow up directly — this isn't an automatic refund.",
    };
  }

  return {
    handled: true,
    decision: "deny_per_policy",
    policyBasis: "https://lazyrelay.com/refunds — no refunds for partial billing periods or change-of-mind",
    customerMessage:
      "Per our Refund Policy (lazyrelay.com/refunds), we don't offer refunds for partial billing periods or change-of-mind. Your plan or add-on stays active until the end of the period you've already paid for, and won't renew if you've cancelled.",
  };
}

module.exports = { getMorStatus, findPastDueNeedingFollowup, planRefund };
