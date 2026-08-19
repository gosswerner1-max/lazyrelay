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

const { getMorCredentials, getRenderCredentials } = require("../config/credentials.js");
const { isInternalTestAccount } = require("../shared/internalTestAccounts.js");

const PAST_DUE_GRACE_HOURS = 24; // money-impacting -> tight loop, same
// reasoning as Lazy Download's vendor-issue follow-up policy (24h for
// money-impacting issues vs 1-2 days for standard ones).

/** Reads Render's ACTUAL deployed env vars via the Render API — rewritten
 * 2026-08-05 after a real incident: this function used to read only the
 * local `backend/.env`, and on 2026-08-05 that file held live Paddle
 * credentials while the DEPLOYED Render service was still fully on sandbox
 * (empty `PADDLE_ENVIRONMENT`, a `pdl_sdbx_...` key) — a mismatch that had
 * apparently existed for a while with nobody noticing, because nothing
 * ever checked deployed reality instead of the laptop's copy. Real
 * customers only ever hit the deployed backend, never this file, so that's
 * the only place billing status can honestly be read from.
 *
 * Returns `{live, environment, source, localDisagreesWithDeployed}` —
 * `source` is `"deployed"` when the Render check succeeded (the trustworthy
 * case), or `"local-fallback"` if Render's API couldn't be reached (network
 * issue, rotated key, etc.) — callers must treat a `local-fallback` result
 * as unverified, not equivalent to a real deployed check.
 * `localDisagreesWithDeployed` is true when the local `.env` and the
 * deployed values differ at all (even if both resolve to the same
 * live/environment verdict) — worth surfacing so this exact drift gets
 * caught immediately next time instead of sitting unnoticed for weeks. */
// Every config key this check compares local vs deployed. Widened
// 2026-08-17 — the original version only ever compared MOR_API_KEY and
// PADDLE_ENVIRONMENT, and `localDisagreesWithDeployed: false` sat there
// reporting "all clear" throughout all three real MOR_WEBHOOK_SECRET
// mismatch incidents (2026-08-04/05/11) and never once caught any of them.
// This function already fetches Render's full env-var list, so comparing
// more keys costs nothing extra. Keep this list in sync with new Paddle
// price IDs as they're added.
//
// 2026-08-19 — that "keep this list in sync" instruction failed on its very
// first test. The three Agency price IDs were created 2026-08-18 and added
// to Render but not here, and not to backend/.env either -- so a real
// Render-vs-local divergence existed for a day while this function reported
// mismatchedKeys: [] the whole time. Exactly the blind spot the 08-17
// widening was written to end, one day later, for the same reason: a list a
// human has to remember to update. If a fourth price ID is ever added, this
// will happen again -- the durable fix is to derive the compared set from
// Render's own PADDLE_* keys rather than hand-maintaining it here.
const COMPARED_KEYS = [
  "MOR_API_KEY",
  "PADDLE_ENVIRONMENT",
  "MOR_WEBHOOK_SECRET",
  "PADDLE_PRICE_ID_STARTER",
  "PADDLE_PRICE_ID_PRO",
  "PADDLE_PRICE_ID_BUSINESS",
  "PADDLE_PRICE_ID_STORAGE_5GB",
  "PADDLE_PRICE_ID_STORAGE_20GB",
  "PADDLE_PRICE_ID_STORAGE_50GB",
  "PADDLE_PRICE_ID_BRAND_ADDON",
  "PADDLE_PRICE_ID_AGENCY",
  "PADDLE_PRICE_ID_AGENCY_PLUS",
  "PADDLE_PRICE_ID_SEAT_ADDON",
];

async function getMorStatus() {
  const localApiKey = process.env.MOR_API_KEY;
  const localEnvironment = process.env.PADDLE_ENVIRONMENT === "production" ? "production" : "sandbox";

  const renderCreds = getRenderCredentials();
  if (!renderCreds) {
    // No Render credentials configured — can't verify deployed reality at
    // all. Fall back to local, but say so honestly rather than pretending
    // this is a verified deployed check.
    const localCreds = getMorCredentials();
    return {
      live: !!localCreds,
      environment: localEnvironment,
      source: "local-fallback",
      localDisagreesWithDeployed: null,
      note: "RENDER_API_KEY/RENDER_SERVICE_ID not configured — could not verify against the deployed service, this is the local .env only.",
    };
  }

  let deployedApiKey, deployedEnvironment, byKey;
  try {
    const res = await fetch(`https://api.render.com/v1/services/${renderCreds.serviceId}/env-vars?limit=100`, {
      headers: { Authorization: `Bearer ${renderCreds.apiKey}` },
    });
    if (!res.ok) throw new Error(`Render API returned ${res.status}`);
    const envVars = await res.json();
    byKey = Object.fromEntries(envVars.map((e) => [e.envVar.key, e.envVar.value]));
    deployedApiKey = byKey.MOR_API_KEY;
    deployedEnvironment = byKey.PADDLE_ENVIRONMENT === "production" ? "production" : "sandbox";
  } catch (err) {
    // Render API unreachable this run — same honest fallback as above,
    // never silently substitute the local file for a real deployed check.
    const localCreds = getMorCredentials();
    return {
      live: !!localCreds,
      environment: localEnvironment,
      source: "local-fallback",
      localDisagreesWithDeployed: null,
      note: `Could not reach Render's API to verify deployed status (${err.message}) — this is the local .env only, not verified against what's actually live.`,
    };
  }

  // Per-key comparison across the full list, not just the original two —
  // `mismatchedKeys` names exactly which ones disagree so a future incident
  // is diagnosable from this report alone, not just "something's off".
  const mismatchedKeys = COMPARED_KEYS.filter((key) => (process.env[key] ?? null) !== (byKey[key] ?? null));
  const localDisagreesWithDeployed = mismatchedKeys.length > 0;

  return {
    live: !!deployedApiKey,
    environment: deployedEnvironment,
    source: "deployed",
    localDisagreesWithDeployed,
    mismatchedKeys,
  };
}

/** Subscriptions stuck in past_due for longer than the grace period —
 * real dunning-follow-up candidates. Requires the MoR to actually be live;
 * reports that honestly rather than returning a misleading empty list. */
async function findPastDueNeedingFollowup(supabase, graceHours = PAST_DUE_GRACE_HOURS) {
  const { live, environment } = await getMorStatus();
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

  // Exclude Werner's own test/internal accounts (added 2026-08-05 after
  // billing went production with real leftover test subscriptions still in
  // the DB, kept deliberately since testing is ongoing) — never send a
  // dunning reminder to our own mailboxes.
  const rows = data ?? [];
  const accountIds = rows.map((r) => r.account_id);
  let candidates = rows;
  if (accountIds.length > 0) {
    const { data: accounts, error: acctError } = await supabase.from("accounts").select("id, email").in("id", accountIds);
    if (acctError) throw acctError;
    const emailById = new Map((accounts ?? []).map((a) => [a.id, a.email]));
    candidates = rows.filter((r) => !isInternalTestAccount(emailById.get(r.account_id)));
  }

  const reason =
    environment === "production"
      ? "ok"
      : `ok, but MoR is in ${environment} mode — these are NOT real customers, do not act on them as real dunning candidates`;
  return { handled: true, reason, environment, candidates };
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
  const { live } = await getMorStatus();
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

/** Storage margin check (added 2026-08-05, per Werner's ask: "so we never
 *  lose money but rather change the price of what we sell storage at").
 *  Real revenue (active/trialing storage_addons) vs real Supabase overage
 *  cost — see ops/shared/storageUsage.js::computeStorageMargin for the
 *  underlying numbers. This is a pricing-review trigger, not an outage
 *  alert: nothing breaks at any margin level (Supabase auto-scales), the
 *  only consequence of an eroding margin is "storage add-on prices need to
 *  go up," which is Werner's call, not something this code does itself. */
async function checkStorageMargin(supabase) {
  const { gatherStorageUsage, computeStorageMargin } = require("../shared/storageUsage.js");
  const storageUsage = await gatherStorageUsage(supabase);
  const margin = await computeStorageMargin(supabase, storageUsage);

  if (margin.monthlyCostUsd === 0) {
    return { ...margin, status: "ok", detail: "No Supabase storage overage cost yet — margin question is moot." };
  }
  if (margin.marginRatio < 1) {
    return {
      ...margin,
      status: "critical",
      detail: `Storage overage cost ($${margin.monthlyCostUsd.toFixed(2)}/mo) EXCEEDS storage add-on revenue ($${margin.monthlyRevenueUsd.toFixed(2)}/mo) — actually losing money on storage. Raise add-on prices.`,
    };
  }
  if (margin.marginRatio < 2) {
    return {
      ...margin,
      status: "warn",
      detail: `Storage margin is thinning — revenue ($${margin.monthlyRevenueUsd.toFixed(2)}/mo) is only ${margin.marginRatio.toFixed(1)}x cost ($${margin.monthlyCostUsd.toFixed(2)}/mo). Worth reviewing add-on pricing before it erodes further.`,
    };
  }
  return {
    ...margin,
    status: "ok",
    detail: `Storage margin healthy — revenue ($${margin.monthlyRevenueUsd.toFixed(2)}/mo) is ${margin.marginRatio.toFixed(1)}x cost ($${margin.monthlyCostUsd.toFixed(2)}/mo).`,
  };
}

module.exports = { getMorStatus, findPastDueNeedingFollowup, planRefund, checkStorageMargin };
