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
  tier: "free" | "pro" | "business" | "enterprise";
  status: "trialing" | "active" | "past_due" | "cancelled";
  currentPeriodEnd: string; // ISO timestamp
}

/** A storage add-on (2026-07-23) is deliberately its OWN Paddle
 *  subscription, not folded into the tier subscription — a customer can
 *  stack multiple add-ons, and cancelling one must not touch the main
 *  tier subscription. See storage_addons migration 0012. */
export interface StorageAddonEvent {
  kind: "storage_addon";
  morSubscriptionId: string;
  accountEmail: string;
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

export type BillingEvent = SubscriptionEvent | StorageAddonEvent | SaleRecordEvent | RefundRecordEvent;

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
}
