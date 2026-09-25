// billing routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.

import { Router } from "express";
import { supabase } from "../../supabase.js";
import { cancelSubscription, cancelStorageAddon, cancelBrandAddon, cancelSeatAddon } from "../../billing/sync.js";
import { acquireBillingLock, releaseBillingLock } from "../../billing/locks.js";
import { buildCheckoutTransaction } from "../../billing/paddle.js";
import { Environment } from "@paddle/paddle-node-sdk";
import type { MerchantOfRecordAdapter } from "../../billing/types.js";
import { requireAuth, requireOwner, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { getBrandCapacity } from "../../brandLimits.js";
import { getSeatCapacity, MAX_SEAT_ADDONS_PER_ACCOUNT } from "../../seatLimits.js";
import { resolveTier } from "../../tier.js";
import { dbError } from "./shared.js";

// Storage add-ons — priced 2026-07-23 after researching real comparables
// (consumer cloud storage clusters $0.005-0.02/GB/mo, the closest real B2B
// benchmark — Microsoft 365 extra storage — runs ~$0.20/GB/mo). Landed on a
// 20-40x markup over the $0.015/GB raw R2 cost: this is discretionary
// convenience pricing on top of an already-paid subscription, not a storage
// product competing on raw economics, so the margin is deliberate. Declining
// $/GB per tier (bigger block = better relative value) mirrors every real
// benchmark found and nudges toward the larger tier instead of repeat-buying
// the small one. Free tier cannot buy add-ons — someone needing more than
// 250MB should upgrade to a real tier first, which itself includes more
// storage; add-ons are for someone already paying who wants MORE than their
// tier's base amount (e.g. Starter + only 10 accounts, but heavy media use).
const STORAGE_ADDON_GB_OPTIONS = [5, 20, 50] as const;
type StorageAddonGb = (typeof STORAGE_ADDON_GB_OPTIONS)[number];
// Closes off unbounded stacking (a scripted retry loop or fat-fingered
// repeat-click spinning up dozens of subscriptions) without affecting any
// real customer — 5 add-ons is already up to +250GB on top of the tier's
// base quota, far beyond realistic single-account usage.
const MAX_ACTIVE_STORAGE_ADDONS = 5;
const ADDON_PRICE_ID_ENV_VAR: Record<StorageAddonGb, string> = {
  5: "PADDLE_PRICE_ID_STORAGE_5GB",
  20: "PADDLE_PRICE_ID_STORAGE_20GB",
  50: "PADDLE_PRICE_ID_STORAGE_50GB",
};

// Brand add-ons (Phase 1b, 2026-08-16) — one flat price, +1 brand slot each,
// ~$10/mo. Same abuse-prevention reasoning as MAX_ACTIVE_STORAGE_ADDONS: a
// customer legitimately running an agency-scale operation belongs on the
// future Agency tier, not stacking 50 add-ons on a self-serve plan.
const MAX_ACTIVE_BRAND_ADDONS = 10;
const BRAND_ADDON_PRICE_ID_ENV_VAR = "PADDLE_PRICE_ID_BRAND_ADDON";
const SEAT_ADDON_PRICE_ID_ENV_VAR = "PADDLE_PRICE_ID_SEAT_ADDON";

// Real gap found in the 2026-08-25 pre-launch audit: /subscription/change-tier
// reads the current subscription, checks it's not already on the target
// tier, then calls Paddle's changeSubscriptionTier -- which charges a real,
// immediate prorated amount -- with no lock between the read and the charge.
// Two concurrent requests for the same account (a double-click, two open
// tabs, a client retry after a slow response) can both pass the check and
// both trigger a real Paddle charge; this is the exact failure class behind
// the real $59.97 unintended-charge incident on 2026-08-21.
//
// 2026-09-01 audit fix: /subscription/checkout had the exact same
// check-then-act shape and no lock at all -- a double-click or two open
// tabs on Free-to-paid checkout could create TWO independent Paddle
// subscriptions, both actually charged, with the local row only ever
// tracking one (onConflict: account_id) -- the other bills the customer
// indefinitely with no way for the app or the customer to see or cancel it.
// Sharing one lock across both routes (and the three add-on checkout routes
// below) is correct: all five represent "this account has an in-flight
// subscription-lifecycle mutation," and there's no legitimate reason to let
// any two of them race each other either.
//
// SECURITY FIX (2026-09-25): this used to be a plain in-process
// `new Set<string>()`, correct only for "single Render instance today"
// (the original comment's own words) -- Render's zero-downtime deploys
// briefly run the old and new process side by side, each with its own
// independent, empty Set, reopening the exact double-purchase race these
// locks exist to close for the length of that overlap. Replaced with a
// durable, cross-process lock backed by a short-lived Supabase row (every
// process already shares that database) -- see billing/locks.ts and
// migration 0091_billing_action_locks.sql for the full mechanism.

export function buildBillingRouter(morAdapter: MerchantOfRecordAdapter): Router {
  const router = Router();

  // Reports the caller's current tier/status — "free" with no status when
  // no subscription row exists yet (a fresh signup before ever upgrading),
  // which is a normal state, not an error.
  router.get("/subscription", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: sub, error } = await req.db!
      .from("subscriptions")
      .select("tier, status, current_period_end, cancel_at_period_end")
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /subscription");
      return;
    }
    if (!sub) {
      res.json({ tier: "free", status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false });
      return;
    }
    res.json({
      tier: sub.tier,
      status: sub.status,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    });
  });

  // Starts a real Paddle checkout transaction for upgrading to a paid tier.
  // Only meaningful once MOR_API_KEY + the tier's price ID env vars exist
  // (see BILLING_KNOWLEDGE.md) — reports a clear error rather than a
  // confusing Paddle SDK exception if they don't.
  router.post("/subscription/checkout", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { tier } = req.body ?? {};
    if (tier !== "pro" && tier !== "business" && tier !== "enterprise" && tier !== "agency" && tier !== "agency_plus") {
      res.status(400).json({
        error:
          'tier must be "pro" (Starter), "business" (Pro), "enterprise" (Business), "agency" (Agency), or "agency_plus" (Agency Plus) — use the Free tier by just not upgrading',
      });
      return;
    }

    const apiKey = process.env.MOR_API_KEY;
    // Internal tier codes were kept stable across the Starter/Pro/Business
    // rename (see tier.ts) — the env var names below reflect the CURRENT
    // display name, not the internal code, so double-check this mapping
    // against tier.ts's TIER_DISPLAY_NAMES before changing either.
    const priceId =
      tier === "pro"
        ? process.env.PADDLE_PRICE_ID_STARTER
        : tier === "business"
          ? process.env.PADDLE_PRICE_ID_PRO
          : tier === "enterprise"
            ? process.env.PADDLE_PRICE_ID_BUSINESS
            : tier === "agency"
              ? process.env.PADDLE_PRICE_ID_AGENCY
              : process.env.PADDLE_PRICE_ID_AGENCY_PLUS;
    if (!apiKey || !priceId) {
      res.status(503).json({
        error: "Billing isn't live yet — no Paddle account/price configured. See BILLING_KNOWLEDGE.md.",
      });
      return;
    }

    // Real gap found in the 2026-09-01 audit: this route had the same
    // check-then-act shape as /subscription/change-tier (see the durable
    // billing-action lock's doc comment above) with no lock at all -- reject
    // a second concurrent checkout for this account outright, before
    // touching the DB or Paddle at all, same as change-tier already does.
    if (!(await acquireBillingLock(req.accountId!, "subscription/checkout"))) {
      res.status(409).json({ error: "A subscription change is already in progress for this account. Please wait for it to finish." });
      return;
    }

    try {
      const { data: account, error: accountError } = await req.db!
        .from("accounts")
        .select("email")
        .eq("id", req.accountId)
        .single();
      if (accountError || !account) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      // Real gap found in the 2026-08-25 pre-launch audit: nothing here
      // checked whether the account already had an active/trialing
      // subscription before starting a fresh Paddle checkout. A stale second
      // tab, or a resubmitted request, could create a SECOND, independent
      // Paddle subscription -- the local subscriptions row only ever holds
      // one (onConflict: "account_id"), so whichever webhook lands last
      // silently overwrites the tracked mor_subscription_id and the app loses
      // all ability to see or cancel the orphaned first subscription, which
      // keeps billing the customer indefinitely. Existing customers upgrading
      // between paid tiers already have their own dedicated endpoint
      // (/subscription/change-tier) -- this one is Free-to-paid only.
      //
      // SECURITY FIX (2026-09-25): this guard used to only check for
      // active/trialing, missing past_due entirely -- a past_due subscription
      // is still nominally alive at Paddle (not yet cancelled), so a
      // past_due customer hitting this route the same way (e.g. a stale tab
      // still showing this account's original tier, or a direct API replay)
      // could open a brand-new second Paddle subscription while the first
      // one was still failing to charge. That second subscription's webhook
      // would then upsert onto the exact same account_id row as the first,
      // silently overwriting mor_subscription_id and orphaning the past_due
      // subscription -- identical outcome to the active/trialing case this
      // guard already covered, just reached from a different status. No
      // self-serve "update payment method" flow exists in this codebase
      // (confirmed: no billing-portal route, no card-update UI) -- past_due
      // recovery today is handled manually via ops/billing/billing_ops.js's
      // findPastDueNeedingFollowup() dunning cadence, so this blocks outright
      // and points the customer at support rather than fabricating a
      // self-serve flow that doesn't exist yet.
      const { data: existingSub, error: existingSubError } = await req.db!
        .from("subscriptions")
        .select("status")
        .eq("account_id", req.accountId)
        .maybeSingle();
      if (existingSubError) {
        dbError(res, existingSubError, "POST /subscription/checkout");
        return;
      }
      if (existingSub && existingSub.status === "past_due") {
        res.status(400).json({
          error:
            "Your existing plan has a payment problem (past due) that needs to be resolved first -- starting a new plan now would leave the old one still charging in the background. Email support@lazyrelay.com and we'll help sort out your payment method.",
        });
        return;
      }
      if (existingSub && (existingSub.status === "active" || existingSub.status === "trialing")) {
        res.status(400).json({
          error: "You already have an active plan. Use the dashboard's upgrade/downgrade option to switch tiers instead.",
        });
        return;
      }

      const environment = process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox;
      try {
        const { transactionId, checkoutUrl } = await buildCheckoutTransaction(apiKey, environment, {
          kind: "tier",
          accountEmail: account.email,
          accountId: req.accountId!,
          tier,
          priceId,
        });
        res.json({ transactionId, checkoutUrl });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      await releaseBillingLock(req.accountId!);
    }
  });

  // Changes an EXISTING active subscription's tier in place (real proration,
  // not a fresh checkout) — found 2026-08-21 that the dashboard had no
  // self-serve upgrade/downgrade path at all once a customer was already
  // paying, only cancel-and-lose-access. /subscription/checkout above is
  // for going from Free (or a lapsed/cancelled account) to a paid tier;
  // this is for moving between paid tiers. See changeSubscriptionTier's doc
  // comment in billing/types.ts for why no local DB write happens here —
  // the resulting webhook is the source of truth, same as every other
  // subscription-lifecycle change.
  router.post("/subscription/change-tier", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { tier } = req.body ?? {};
    if (tier !== "pro" && tier !== "business" && tier !== "enterprise" && tier !== "agency" && tier !== "agency_plus") {
      res.status(400).json({
        error:
          'tier must be "pro" (Starter), "business" (Pro), "enterprise" (Business), "agency" (Agency), or "agency_plus" (Agency Plus)',
      });
      return;
    }

    const apiKey = process.env.MOR_API_KEY;
    const priceId =
      tier === "pro"
        ? process.env.PADDLE_PRICE_ID_STARTER
        : tier === "business"
          ? process.env.PADDLE_PRICE_ID_PRO
          : tier === "enterprise"
            ? process.env.PADDLE_PRICE_ID_BUSINESS
            : tier === "agency"
              ? process.env.PADDLE_PRICE_ID_AGENCY
              : process.env.PADDLE_PRICE_ID_AGENCY_PLUS;
    if (!apiKey || !priceId) {
      res.status(503).json({
        error: "Billing isn't live yet — no Paddle account/price configured. See BILLING_KNOWLEDGE.md.",
      });
      return;
    }

    // Reject a second concurrent change-tier request for this account
    // outright, before touching the DB or Paddle at all -- see the durable
    // billing-action lock's doc comment above for why this exists.
    if (!(await acquireBillingLock(req.accountId!, "subscription/change-tier"))) {
      res.status(409).json({ error: "A tier change is already in progress for this account. Please wait for it to finish." });
      return;
    }

    try {
      const { data: account, error: accountError } = await req.db!
        .from("accounts")
        .select("email")
        .eq("id", req.accountId)
        .single();
      if (accountError || !account) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      const { data: subscription, error: subError } = await req.db!
        .from("subscriptions")
        .select("mor_subscription_id, tier, status")
        .eq("account_id", req.accountId)
        .maybeSingle();
      if (subError) {
        dbError(res, subError, "POST /subscription/change-tier");
        return;
      }
      if (!subscription || (subscription.status !== "active" && subscription.status !== "trialing")) {
        res.status(400).json({ error: "No active subscription to change — subscribe via /subscription/checkout first." });
        return;
      }
      if (subscription.tier === tier) {
        res.status(400).json({ error: "Already on this tier." });
        return;
      }

      const result = await morAdapter.changeSubscriptionTier(subscription.mor_subscription_id, priceId, tier, account.email, req.accountId!);
      if (!result.success) {
        res.status(502).json({ error: result.errorMessage ?? "Tier change failed at the payment provider" });
        return;
      }
      res.json({ changed: true });
    } finally {
      await releaseBillingLock(req.accountId!);
    }
  });

  // The cancellation flow — this is THE trust-critical endpoint. Cancels
  // with the Merchant of Record first; only then does the local record
  // get marked cancelled. See billing/sync.ts for the full reasoning.
  router.post("/subscription/cancel", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { feedback, acknowledgedDataDeletion } = req.body ?? {};
    const result = await cancelSubscription(
      req.accountId!,
      morAdapter,
      typeof feedback === "string" ? feedback : undefined,
      acknowledgedDataDeletion === true,
    );
    if (!result.success) {
      // Missing acknowledgement is a caller error, not a payment-provider
      // failure -- keep it distinguishable from the 502 case below so the
      // frontend can tell "you forgot to check the box" apart from "Paddle
      // itself rejected this."
      const status = result.errorMessage?.startsWith("You must acknowledge") ? 400 : 502;
      res.status(status).json({ error: result.errorMessage ?? "Cancellation failed at the payment provider" });
      return;
    }
    res.json({ cancelled: true });
  });

  // Lists the caller's active/trialing storage add-ons — the "manage your
  // extra storage" view alongside the storage gauge.
  router.get("/storage-addons", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    // storage_addons: service-role only throughout this file --
    // 0012_storage_addons.sql: "No client-facing RLS policies... only the
    // backend's service-role client ever touches this table."
    const { data, error } = await supabase
      .from("storage_addons")
      .select("id, gb_amount, status, current_period_end, cancel_at_period_end")
      .eq("account_id", req.accountId)
      .in("status", ["active", "trialing"])
      .order("created_at", { ascending: true });
    if (error) {
      dbError(res, error, "GET /storage-addons");
      return;
    }
    res.json(data);
  });

  // Starts a real Paddle checkout transaction for a storage add-on. Free
  // tier can't buy add-ons — upgrading to a real tier already includes more
  // storage; add-ons are for someone already paying who wants MORE than
  // their tier's base amount. Same checkout-overlay pattern as
  // /subscription/checkout, just a different customData shape (see
  // buildCheckoutTransaction in billing/paddle.ts).
  router.post("/storage-addons/checkout", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { gbAmount } = req.body ?? {};
    if (!STORAGE_ADDON_GB_OPTIONS.includes(gbAmount)) {
      res.status(400).json({ error: `gbAmount must be one of ${STORAGE_ADDON_GB_OPTIONS.join(", ")}` });
      return;
    }

    const tier = await resolveTier(req.accountId!);
    if (tier === "free") {
      res.status(403).json({ error: "Storage add-ons aren't available on the Free tier — upgrade to a paid plan first." });
      return;
    }

    // SECURITY FIX (2026-09-14): this route had the exact same
    // check-then-act shape as /subscription/checkout with no lock at
    // all -- two concurrent requests (double-click, two tabs) could both
    // pass the active-count check below and both create a real Paddle
    // transaction, exceeding MAX_ACTIVE_STORAGE_ADDONS and/or resulting
    // in two real charges. Reusing the same durable billing-action lock
    // (see its own doc comment above) rather than a separate lock, since a
    // tier-change racing an add-on checkout for the same account is the
    // same underlying bug.
    if (!(await acquireBillingLock(req.accountId!, "storage-addons/checkout"))) {
      res.status(409).json({ error: "A billing change is already in progress for this account. Please wait for it to finish." });
      return;
    }

    try {
      // storage_addons: service-role only, see GET /storage-addons above.
      const { count: activeAddonCount, error: countError } = await supabase
        .from("storage_addons")
        .select("id", { count: "exact", head: true })
        .eq("account_id", req.accountId)
        .in("status", ["active", "trialing"]);
      if (countError) {
        dbError(res, countError, "POST /storage-addons/checkout active-count");
        return;
      }
      if ((activeAddonCount ?? 0) >= MAX_ACTIVE_STORAGE_ADDONS) {
        res.status(403).json({
          error: `You already have ${MAX_ACTIVE_STORAGE_ADDONS} storage add-ons — cancel one before adding another.`,
        });
        return;
      }

      const apiKey = process.env.MOR_API_KEY;
      const priceId = ADDON_PRICE_ID_ENV_VAR[gbAmount as StorageAddonGb] ? process.env[ADDON_PRICE_ID_ENV_VAR[gbAmount as StorageAddonGb]] : undefined;
      if (!apiKey || !priceId) {
        res.status(503).json({ error: "Billing isn't live yet — no Paddle account/price configured for this add-on." });
        return;
      }

      const { data: account, error: accountError } = await req.db!
        .from("accounts")
        .select("email")
        .eq("id", req.accountId)
        .single();
      if (accountError || !account) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      const environment = process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox;
      try {
        const { transactionId, checkoutUrl } = await buildCheckoutTransaction(apiKey, environment, {
          kind: "storage_addon",
          accountEmail: account.email,
          accountId: req.accountId!,
          gbAmount,
          priceId,
        });
        res.json({ transactionId, checkoutUrl });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      await releaseBillingLock(req.accountId!);
    }
  });

  // Cancels a single storage add-on — does not touch the account's main
  // tier subscription. See billing/sync.ts's cancelStorageAddon.
  router.post("/storage-addons/:id/cancel", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const result = await cancelStorageAddon(req.accountId!, String(req.params.id), morAdapter);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Cancellation failed at the payment provider" });
      return;
    }
    res.json({ cancelled: true });
  });

  // Brand add-ons (Phase 1b, 2026-08-16) — same three-route shape as storage
  // add-ons above (list / checkout / cancel), but the list response also
  // carries the account's real effective brand capacity (base tier limit +
  // active add-on slots) so the frontend can show "N/cap" honestly without a
  // second round trip.
  router.get("/brand-addons", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    // brand_addons: service-role only throughout this file --
    // 0048_brand_addons.sql: "No client-facing RLS policies... only the
    // backend's service-role client ever touches this table."
    const [{ data, error }, capacity] = await Promise.all([
      supabase
        .from("brand_addons")
        .select("id, status, current_period_end, cancel_at_period_end")
        .eq("account_id", req.accountId)
        .in("status", ["active", "trialing"])
        .order("created_at", { ascending: true }),
      getBrandCapacity(req.accountId!),
    ]);
    if (error) {
      dbError(res, error, "GET /brand-addons");
      return;
    }
    res.json({ addons: data, baseLimit: capacity.baseLimit, addonSlots: capacity.addonSlots, totalLimit: capacity.totalLimit });
  });

  // Starts a real Paddle checkout transaction for one brand add-on (+1 brand
  // slot). Same free-tier exclusion and pattern as /storage-addons/checkout —
  // a customer already on a paid tier who wants MORE brands than their
  // tier's base allowance.
  router.post("/brand-addons/checkout", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const tier = await resolveTier(req.accountId!);
    if (tier === "free") {
      res.status(403).json({ error: "Brand add-ons aren't available on the Free tier — upgrade to a paid plan first." });
      return;
    }

    // SECURITY FIX (2026-09-14): same missing-lock race as
    // /storage-addons/checkout above -- see that fix's comment.
    if (!(await acquireBillingLock(req.accountId!, "brand-addons/checkout"))) {
      res.status(409).json({ error: "A billing change is already in progress for this account. Please wait for it to finish." });
      return;
    }

    try {
      // brand_addons: service-role only, see GET /brand-addons above.
      const { count: activeAddonCount, error: countError } = await supabase
        .from("brand_addons")
        .select("id", { count: "exact", head: true })
        .eq("account_id", req.accountId)
        .in("status", ["active", "trialing"]);
      if (countError) {
        dbError(res, countError, "POST /brand-addons/checkout active-count");
        return;
      }
      if ((activeAddonCount ?? 0) >= MAX_ACTIVE_BRAND_ADDONS) {
        res.status(403).json({
          error: `You already have ${MAX_ACTIVE_BRAND_ADDONS} brand add-ons — cancel one before adding another, or talk to us about an Agency plan.`,
        });
        return;
      }

      const apiKey = process.env.MOR_API_KEY;
      const priceId = process.env[BRAND_ADDON_PRICE_ID_ENV_VAR];
      if (!apiKey || !priceId) {
        res.status(503).json({ error: "Billing isn't live yet — no Paddle price configured for this add-on." });
        return;
      }

      const { data: account, error: accountError } = await req.db!
        .from("accounts")
        .select("email")
        .eq("id", req.accountId)
        .single();
      if (accountError || !account) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      const environment = process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox;
      try {
        const { transactionId, checkoutUrl } = await buildCheckoutTransaction(apiKey, environment, {
          kind: "brand_addon",
          accountEmail: account.email,
          accountId: req.accountId!,
          priceId,
        });
        res.json({ transactionId, checkoutUrl });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      await releaseBillingLock(req.accountId!);
    }
  });

  // Cancels a single brand add-on — does not touch the account's main tier
  // subscription. See billing/sync.ts's cancelBrandAddon.
  router.post("/brand-addons/:id/cancel", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const result = await cancelBrandAddon(req.accountId!, String(req.params.id), morAdapter);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Cancellation failed at the payment provider" });
      return;
    }
    res.json({ cancelled: true });
  });

  // Seat add-ons (Agency pricing pass, 2026-08-17) — same three-route shape
  // as brand add-ons above, but with a stricter tier gate: brand add-ons are
  // buyable on any paid tier, while seats only exist on Business/Agency/
  // Agency Plus (see SEAT_LIMITS in seatLimits.ts) — so this excludes "pro"
  // and "business" (internal codes; Starter/Pro displayed), not just "free".
  router.get("/seat-addons", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    // seat_addons: service-role only throughout this file --
    // 0054_agency_tiers_and_seats.sql: "No client-facing RLS policies...
    // only the backend's service-role client ever touches this table."
    const [{ data, error }, capacity] = await Promise.all([
      supabase
        .from("seat_addons")
        .select("id, status, current_period_end, cancel_at_period_end")
        .eq("account_id", req.accountId)
        .in("status", ["active", "trialing"])
        .order("created_at", { ascending: true }),
      getSeatCapacity(req.accountId!),
    ]);
    if (error) {
      dbError(res, error, "GET /seat-addons");
      return;
    }
    res.json({ addons: data, baseLimit: capacity.baseLimit, addonSlots: capacity.addonSlots, totalLimit: capacity.totalLimit });
  });

  router.post("/seat-addons/checkout", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const tier = await resolveTier(req.accountId!);
    if (tier !== "enterprise" && tier !== "agency" && tier !== "agency_plus") {
      res.status(403).json({ error: "Seat add-ons are only available on Business, Agency, or Agency Plus — upgrade first." });
      return;
    }

    // SECURITY FIX (2026-09-14): same missing-lock race as
    // /storage-addons/checkout above -- see that fix's comment.
    if (!(await acquireBillingLock(req.accountId!, "seat-addons/checkout"))) {
      res.status(409).json({ error: "A billing change is already in progress for this account. Please wait for it to finish." });
      return;
    }

    try {
      // seat_addons: service-role only, see GET /seat-addons above.
      const { count: activeAddonCount, error: countError } = await supabase
        .from("seat_addons")
        .select("id", { count: "exact", head: true })
        .eq("account_id", req.accountId)
        .in("status", ["active", "trialing"]);
      if (countError) {
        dbError(res, countError, "POST /seat-addons/checkout active-count");
        return;
      }
      if ((activeAddonCount ?? 0) >= MAX_SEAT_ADDONS_PER_ACCOUNT) {
        res.status(403).json({
          error: `You already have ${MAX_SEAT_ADDONS_PER_ACCOUNT} seat add-ons — cancel one before adding another.`,
        });
        return;
      }

      const apiKey = process.env.MOR_API_KEY;
      const priceId = process.env[SEAT_ADDON_PRICE_ID_ENV_VAR];
      if (!apiKey || !priceId) {
        res.status(503).json({ error: "Billing isn't live yet — no Paddle price configured for this add-on." });
        return;
      }

      const { data: account, error: accountError } = await req.db!
        .from("accounts")
        .select("email")
        .eq("id", req.accountId)
        .single();
      if (accountError || !account) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      const environment = process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox;
      try {
        const { transactionId, checkoutUrl } = await buildCheckoutTransaction(apiKey, environment, {
          kind: "seat_addon",
          accountEmail: account.email,
          accountId: req.accountId!,
          priceId,
        });
        res.json({ transactionId, checkoutUrl });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      await releaseBillingLock(req.accountId!);
    }
  });

  // Cancels a single seat add-on — does not touch the account's main tier
  // subscription. See billing/sync.ts's cancelSeatAddon.
  router.post("/seat-addons/:id/cancel", requireAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const result = await cancelSeatAddon(req.accountId!, String(req.params.id), morAdapter);
    if (!result.success) {
      res.status(502).json({ error: result.errorMessage ?? "Cancellation failed at the payment provider" });
      return;
    }
    res.json({ cancelled: true });
  });

  return router;
}
