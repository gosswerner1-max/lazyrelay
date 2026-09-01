// Merchant-of-Record adapter interface. Decided (revised 2026-07-22): build
// the real implementation against Paddle. Stripe Managed Payments was the
// first choice but turned out not to work — Stripe doesn't support South
// Africa as an account home country at all without incorporating a foreign
// (e.g. US, via Stripe Atlas) entity first, which is real overhead the user
// doesn't want to take on right now. PayPal was also considered and ruled
// out: no MoR tax handling (same burden Paddle/Stripe both solve), a
// documented Nov-2025 IPN outage that caused exactly the "paid but not
// activated" failure mode this whole decision exists to avoid, and an
// active, current fund-hold/account-freeze reputation. Paddle does have its
// own documented risk-review account-hold complaints (why it wasn't the
// first choice), but unlike Stripe it works directly from South Africa, and
// unlike PayPal it's a true MoR with no comparable recent outage on record.
// Subscription/webhook handling is written against this interface rather
// than the Paddle SDK directly, same pattern as the platform adapters —
// swap StubMorAdapter for the real Paddle implementation without touching
// routes.ts/webhook.ts.

export interface SubscriptionEvent {
  kind: "tier";
  morSubscriptionId: string;
  accountEmail: string;
  // The account's stable UUID, embedded in customData at checkout time
  // (2026-09-01 audit fix) — preferred over accountEmail for resolving which
  // account a webhook belongs to. Optional only so a transaction created by
  // the pre-fix checkout code, still in flight across the deploy, still
  // resolves correctly via the accountEmail fallback.
  accountId?: string;
  tier: "free" | "pro" | "business" | "enterprise" | "agency" | "agency_plus";
  status: "trialing" | "active" | "past_due" | "cancelled";
  currentPeriodEnd: string; // ISO timestamp
  // Paddle's own event.occurredAt (2026-08-25, pre-launch audit fix) — used
  // by syncSubscriptionFromWebhook to detect and skip a stale, out-of-order
  // delivery (Paddle does not guarantee in-order webhook delivery). Only on
  // the tier event, not the add-on kinds below — those don't drive the
  // cancelled_at/data-deletion-clock logic this exists to protect.
  occurredAt: string; // ISO timestamp
}

/** A storage add-on (2026-07-23) is deliberately its OWN Paddle
 *  subscription, not folded into the tier subscription — a customer can
 *  stack multiple add-ons, and cancelling one must not touch the main
 *  tier subscription. See storage_addons migration 0012. */
export interface StorageAddonEvent {
  kind: "storage_addon";
  morSubscriptionId: string;
  accountEmail: string;
  accountId?: string; // see SubscriptionEvent.accountId
  gbAmount: number;
  status: "trialing" | "active" | "past_due" | "cancelled";
  currentPeriodEnd: string; // ISO timestamp
}

/** A completed Paddle transaction ("a sale") — captured for IPE Projects'
 *  own SARS bookkeeping, per the user's requirement (2026-07-23). Paddle is
 *  the merchant of record and issues its own tax invoice to the customer;
 *  this is a separate, internal-only record of the payment Paddle actually
 *  collected and what it paid out to IPE Projects for it. Never sent to the
 *  customer — see billing_records migration 0014 and BILLING_KNOWLEDGE.md. */
export interface SaleRecordEvent {
  kind: "sale_record";
  accountEmail: string;
  accountId?: string; // see SubscriptionEvent.accountId
  paddleTransactionId: string;
  paddleSubscriptionId: string | null;
  invoiceNumber: string | null;
  currencyCode: string;
  subtotal: string;
  tax: string;
  total: string;
  grandTotal: string;
  payoutCurrencyCode: string | null;
  payoutSubtotal: string | null;
  payoutTax: string | null;
  payoutFee: string | null;
  payoutEarnings: string | null;
  occurredAt: string; // ISO timestamp — Paddle's billedAt
}

/** A Paddle refund/credit adjustment — same internal-bookkeeping purpose as
 *  SaleRecordEvent. No accountEmail of its own (Paddle's adjustment payload
 *  doesn't carry one) — resolved by sync.ts via the linked sale record. */
export interface RefundRecordEvent {
  kind: "refund_record";
  paddleAdjustmentId: string;
  paddleTransactionId: string; // links back to the original sale
  paddleSubscriptionId: string | null;
  reason: string;
  currencyCode: string;
  subtotal: string;
  tax: string;
  total: string;
  occurredAt: string; // ISO timestamp — Paddle's createdAt
}

/** A brand add-on (Phase 1b, 2026-08-16) — same "own Paddle subscription"
 *  reasoning as StorageAddonEvent above, but flat: each add-on is exactly
 *  +1 brand slot, no size field. See brand_addons migration 0048. */
export interface BrandAddonEvent {
  kind: "brand_addon";
  morSubscriptionId: string;
  accountEmail: string;
  accountId?: string; // see SubscriptionEvent.accountId
  status: "trialing" | "active" | "past_due" | "cancelled";
  currentPeriodEnd: string; // ISO timestamp
}

/** A seat add-on (Agency pricing pass, 2026-08-17) — same "own Paddle
 *  subscription" reasoning as BrandAddonEvent above: each add-on is exactly
 *  +1 team seat, no size field. See seat_addons migration 0054. */
export interface SeatAddonEvent {
  kind: "seat_addon";
  morSubscriptionId: string;
  accountEmail: string;
  accountId?: string; // see SubscriptionEvent.accountId
  status: "trialing" | "active" | "past_due" | "cancelled";
  currentPeriodEnd: string; // ISO timestamp
}

export type BillingEvent = SubscriptionEvent | StorageAddonEvent | BrandAddonEvent | SeatAddonEvent | SaleRecordEvent | RefundRecordEvent;

/** Thrown by parseWebhookEvent specifically when the signature itself is
 *  invalid — distinct from any other error parseWebhookEvent can throw
 *  (unmapped status, missing customData, malformed payload), so the HTTP
 *  handler can tell a forged/misconfigured request apart from a genuine
 *  Paddle delivery whose data just didn't parse. Found 2026-08-11: both
 *  cases used to surface as an identical 401 "Invalid webhook signature,"
 *  which took real debugging time to untangle from an actual bad secret. */
export class WebhookSignatureError extends Error {}

export interface CancelResult {
  success: boolean;
  errorMessage: string | null;
}

export interface MerchantOfRecordAdapter {
  /** Parses a raw webhook payload into our normalized shape. Throws if the
   *  signature doesn't verify — never trust an unverified webhook. Returns
   *  null for a verified-but-irrelevant event (e.g. a refund or a payment
   *  event with no subscription-lifecycle change to sync) — the webhook
   *  handler treats null as "200 OK, nothing to do," not an error.
   *  ASYNC: Paddle's own signature verification (webhooks.unmarshal) is a
   *  Promise, discovered while implementing PaddleMorAdapter — this was
   *  synchronous when only Stripe was the target, changed when Paddle
   *  replaced it (see billing/paddle.ts). */
  parseWebhookEvent(rawBody: string, signatureHeader: string): Promise<BillingEvent | null>;

  /** Cancels a subscription with the MoR directly — this must actually
   *  cancel, not just mark our own local status, since Blotato's #1
   *  documented failure was exactly this gap (settings-page bug that
   *  never reached the real cancellation, causing repeat charges). */
  cancelSubscription(morSubscriptionId: string): Promise<CancelResult>;

  /** Changes an EXISTING active subscription's price in place — a real
   *  upgrade/downgrade with proration, not a fresh checkout transaction.
   *  Found 2026-08-21: the dashboard had no self-serve way for an
   *  already-paying customer to move between tiers at all, only
   *  cancel-and-lose-access. Charges/credits the prorated difference on
   *  the customer's existing saved payment method immediately — no
   *  checkout overlay needed, unlike a brand-new subscription. Passes an
   *  updated customData.tier in the same call so the resulting
   *  subscription.updated webhook (already handled by
   *  syncSubscriptionFromWebhook, upserted on account_id) picks up the
   *  new tier correctly — this is the single source of truth for the
   *  local `subscriptions` row, deliberately not written synchronously
   *  here. */
  changeSubscriptionTier(morSubscriptionId: string, priceId: string, tier: string, accountEmail: string, accountId: string): Promise<CancelResult>;

  /** Cancels a subscription EFFECTIVE IMMEDIATELY, not deferred to period
   *  end like cancelSubscription() above — added 2026-09-01 for the
   *  chargeback path (billing/sync.ts's recordRefund): a customer who has
   *  already reversed a payment via their bank should not keep paid access
   *  for the rest of that period the way a normal self-serve cancel
   *  promises. Paddle's own docs don't say whether a chargeback already
   *  auto-cancels the subscription on their side — calling this regardless
   *  is the defensive choice; confirm against a real Paddle sandbox
   *  chargeback that calling it on an already-cancelled subscription is a
   *  safe no-op, not a hard error, before fully trusting this path. */
  revokeSubscriptionImmediately(morSubscriptionId: string): Promise<CancelResult>;
}
