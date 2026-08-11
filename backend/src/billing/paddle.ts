import { Paddle, Environment } from "@paddle/paddle-node-sdk";
import { WebhookSignatureError } from "./types.js";
import type {
  MerchantOfRecordAdapter,
  BillingEvent,
  SubscriptionEvent,
  SaleRecordEvent,
  RefundRecordEvent,
  CancelResult,
} from "./types.js";

// Real Paddle Billing adapter — see BILLING_KNOWLEDGE.md for why Paddle was
// chosen over Stripe Managed Payments (Stripe doesn't support South Africa
// as an account home country without a foreign entity) and over PayPal (no
// MoR tax handling, a documented Nov-2025 IPN outage causing exactly the
// "paid but not activated" failure mode, and a live fund-hold reputation).
//
// Confirmed by reading the installed @paddle/paddle-node-sdk's own .d.ts
// files directly (2026-07-22), not just docs/blog posts — two real
// surprises found this way that a docs-only read would have missed:
// (1) `webhooks.unmarshal()` is ASYNC (returns Promise<EventEntity>), unlike
//     Stripe's synchronous constructEvent — MerchantOfRecordAdapter's
//     interface had to change to Promise<BillingEvent | null>.
// (2) `transactions.create()` requires a `customerId`, not an inline email —
//     Paddle has no "create transaction for arbitrary email" shortcut, so a
//     get-or-create Customer lookup is a required step, not a nicety.
//
// Event names confirmed from the SDK's own EventName enum: subscription
// lifecycle events are `subscription.created/activated/updated/past_due/
// paused/canceled/trialing/resumed/imported` (note: "canceled", one "l").
// Custom metadata field is `customData` (SDK) / `custom_data` (raw API),
// echoed back on every webhook — same synchronous-parsing-friendly design
// as the (now-removed) Stripe adapter: embed identifying data in customData
// at checkout-creation time so parsing itself needs no extra network call
// beyond the (already-async) signature verification.
//
// 2026-07-23: extended to also handle storage add-ons (see storage_addons
// migration 0012) — each add-on is its own Paddle subscription, distinguished
// from a tier subscription via customData.kind, not a separate event type.

const STATUS_MAP: Record<string, SubscriptionEvent["status"] | undefined> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  paused: "past_due", // treated as a payment-lapse state for our tier model, not a true cancellation
  canceled: "cancelled",
};

const RELEVANT_EVENT_TYPES = new Set([
  "subscription.created",
  "subscription.activated",
  "subscription.updated",
  "subscription.past_due",
  "subscription.paused",
  "subscription.canceled",
  // Added 2026-07-23 for internal SARS bookkeeping records (billing_records,
  // migration 0014) — a completed sale and a refund/credit adjustment,
  // distinct from the subscription-lifecycle events above.
  "transaction.completed",
  "adjustment.created",
]);

export const VALID_TIERS = ["free", "pro", "business", "enterprise"] as const;

interface SubscriptionLike {
  id: string;
  status: string;
  customData: Record<string, unknown> | null;
  currentBillingPeriod: { endsAt: string } | null;
}

/** Branches on customData.kind to build either a tier SubscriptionEvent or
 *  a StorageAddonEvent — the two are otherwise-identical Paddle
 *  subscriptions distinguished only by what we embedded at checkout time. */
function buildEventFromCustomData(sub: SubscriptionLike, status: SubscriptionEvent["status"]): BillingEvent {
  const customData = sub.customData ?? {};
  const accountEmail = customData.accountEmail;
  if (typeof accountEmail !== "string" || !accountEmail) {
    throw new Error(`Subscription ${sub.id} has no customData.accountEmail — was it created via buildCheckoutTransaction?`);
  }
  const currentPeriodEnd = sub.currentBillingPeriod?.endsAt ?? new Date().toISOString();

  if (customData.kind === "storage_addon") {
    const gbAmount = customData.gbAmount;
    if (typeof gbAmount !== "number" || gbAmount <= 0) {
      throw new Error(`Subscription ${sub.id} has invalid/missing customData.gbAmount "${String(gbAmount)}"`);
    }
    return { kind: "storage_addon", morSubscriptionId: sub.id, accountEmail, gbAmount, status, currentPeriodEnd };
  }

  const tier = customData.tier;
  if (typeof tier !== "string" || !(VALID_TIERS as readonly string[]).includes(tier)) {
    throw new Error(`Subscription ${sub.id} has invalid/missing customData.tier "${String(tier)}"`);
  }
  return { kind: "tier", morSubscriptionId: sub.id, accountEmail, tier: tier as SubscriptionEvent["tier"], status, currentPeriodEnd };
}

interface TransactionTotalsLike {
  subtotal: string;
  tax: string;
  total: string;
  grandTotal: string;
}
interface TransactionPayoutTotalsLike {
  currencyCode: string;
  subtotal: string;
  tax: string;
  fee: string;
  earnings: string;
}
interface TransactionLike {
  id: string;
  customData: Record<string, unknown> | null;
  subscriptionId: string | null;
  invoiceNumber: string | null;
  currencyCode: string;
  billedAt: string | null;
  details: {
    totals: TransactionTotalsLike | null;
    payoutTotals: TransactionPayoutTotalsLike | null;
  } | null;
}

/** Builds the internal SARS bookkeeping record for a completed sale. Reuses
 *  the same customData.accountEmail trick already relied on for
 *  subscriptions — embedded at checkout time via buildCheckoutTransaction,
 *  echoed back on the transaction webhook, so no extra Paddle API call is
 *  needed to resolve who this sale belongs to. */
function buildSaleRecordEvent(txn: TransactionLike): SaleRecordEvent {
  const customData = txn.customData ?? {};
  const accountEmail = customData.accountEmail;
  if (typeof accountEmail !== "string" || !accountEmail) {
    throw new Error(`Transaction ${txn.id} has no customData.accountEmail — was it created via buildCheckoutTransaction?`);
  }
  const totals = txn.details?.totals;
  if (!totals) throw new Error(`Transaction ${txn.id} has no details.totals — cannot record a sale without amounts`);
  const payoutTotals = txn.details?.payoutTotals ?? null;

  return {
    kind: "sale_record",
    accountEmail,
    paddleTransactionId: txn.id,
    paddleSubscriptionId: txn.subscriptionId,
    invoiceNumber: txn.invoiceNumber,
    currencyCode: txn.currencyCode,
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    grandTotal: totals.grandTotal,
    payoutCurrencyCode: payoutTotals?.currencyCode ?? null,
    payoutSubtotal: payoutTotals?.subtotal ?? null,
    payoutTax: payoutTotals?.tax ?? null,
    payoutFee: payoutTotals?.fee ?? null,
    payoutEarnings: payoutTotals?.earnings ?? null,
    occurredAt: txn.billedAt ?? new Date().toISOString(),
  };
}

interface AdjustmentTotalsLike {
  subtotal: string;
  tax: string;
  total: string;
}
interface AdjustmentLike {
  id: string;
  action: string;
  transactionId: string;
  subscriptionId: string | null;
  reason: string;
  currencyCode: string;
  totals: AdjustmentTotalsLike | null;
  createdAt: string;
}

/** Builds the internal SARS bookkeeping record for a refund/credit
 *  adjustment. Unlike a sale, Paddle's adjustment payload carries no
 *  customer email — sync.ts resolves the account by looking up the
 *  original sale record already stored for this transactionId. */
function buildRefundRecordEvent(adj: AdjustmentLike): RefundRecordEvent {
  const totals = adj.totals;
  if (!totals) throw new Error(`Adjustment ${adj.id} has no totals — cannot record a refund without amounts`);

  return {
    kind: "refund_record",
    paddleAdjustmentId: adj.id,
    paddleTransactionId: adj.transactionId,
    paddleSubscriptionId: adj.subscriptionId,
    reason: `${adj.action}: ${adj.reason}`,
    currencyCode: adj.currencyCode,
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    occurredAt: adj.createdAt,
  };
}

export class PaddleMorAdapter implements MerchantOfRecordAdapter {
  private paddle: Paddle;

  constructor(apiKey: string, private webhookSecret: string, environment: Environment = Environment.production) {
    this.paddle = new Paddle(apiKey, { environment });
  }

  /** ASYNC — unlike the removed Stripe adapter, Paddle's own signature
   * verification (`webhooks.unmarshal`) is a Promise, so this had to become
   * one too (MerchantOfRecordAdapter's interface is `Promise<...>` for this
   * reason — see types.ts). Returns null for a verified-but-irrelevant event.
   *
   * Checks the signature explicitly via the SDK's own `isSignatureValid`
   * BEFORE calling `unmarshal` — unmarshal bundles signature verification
   * together with parsing/constructing the typed event, so a single
   * try/catch around it can't tell a forged signature apart from a
   * genuine, correctly-signed delivery whose payload just doesn't parse
   * cleanly (missing fields, an unmapped status, etc.). Confirmed live
   * 2026-08-11: a real destination secret against a minimal/incomplete
   * payload threw from inside unmarshal, indistinguishable from an actual
   * bad secret without this split. Only a real signature mismatch throws
   * WebhookSignatureError; anything after that point is a genuine Paddle
   * delivery with a data problem, not a security event. */
  async parseWebhookEvent(rawBody: string, signatureHeader: string): Promise<BillingEvent | null> {
    const isValid = await this.paddle.webhooks.isSignatureValid(rawBody, this.webhookSecret, signatureHeader);
    if (!isValid) {
      throw new WebhookSignatureError("Webhook signature verification failed");
    }
    const event = await this.paddle.webhooks.unmarshal(rawBody, this.webhookSecret, signatureHeader);

    if (!RELEVANT_EVENT_TYPES.has(event.eventType)) {
      // Anything else — verified-legitimate, nothing to sync.
      return null;
    }

    if (event.eventType === "transaction.completed") {
      return buildSaleRecordEvent(event.data as unknown as TransactionLike);
    }
    if (event.eventType === "adjustment.created") {
      return buildRefundRecordEvent(event.data as unknown as AdjustmentLike);
    }

    const subscription = event.data as unknown as SubscriptionLike;
    const status = event.eventType === "subscription.canceled" ? "cancelled" : STATUS_MAP[subscription.status];
    if (!status) {
      throw new Error(`Unmapped Paddle subscription status "${subscription.status}" for ${subscription.id}`);
    }

    return buildEventFromCustomData(subscription, status);
  }

  async cancelSubscription(morSubscriptionId: string): Promise<CancelResult> {
    try {
      await this.paddle.subscriptions.cancel(morSubscriptionId, { effectiveFrom: "immediately" });
      return { success: true, errorMessage: null };
    } catch (err) {
      return { success: false, errorMessage: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Finds an existing Paddle Customer by email, or creates one — required
 * because transactions.create() needs a customerId, there's no
 * create-transaction-for-arbitrary-email shortcut in Paddle Billing. */
async function getOrCreateCustomerId(paddle: Paddle, email: string): Promise<string> {
  const existing = await paddle.customers.list({ email: [email] }).next();
  if (existing.length > 0) return existing[0].id;
  const created = await paddle.customers.create({ email });
  return created.id;
}

type CheckoutParams =
  | { kind: "tier"; accountEmail: string; tier: "pro" | "business" | "enterprise"; priceId: string }
  | { kind: "storage_addon"; accountEmail: string; gbAmount: number; priceId: string };

/** Creates a Paddle transaction to check out. Returns the transactionId,
 * which the frontend passes to Paddle.js's `Paddle.Checkout.open({
 * transactionId })` to render the real payment overlay on our own page —
 * Paddle Billing has no hosted Checkout Session page the way Stripe does;
 * checkout.url (kept below) only comes into play if Paddle.js itself fails
 * to load, as a plain-redirect fallback. There is no direct "create
 * subscription for a brand-new customer" call in Paddle Billing either — a
 * subscription is created by Paddle as a side effect of a completed
 * transaction, so this is the correct entry point, not a workaround.
 *
 * Handles both a tier upgrade and a storage add-on purchase — the only
 * difference is what gets embedded in customData, which is what
 * buildEventFromCustomData() above branches on when the webhook comes back. */
export async function buildCheckoutTransaction(
  apiKey: string,
  environment: Environment,
  params: CheckoutParams
): Promise<{ transactionId: string; checkoutUrl: string | null }> {
  const paddle = new Paddle(apiKey, { environment });
  const customerId = await getOrCreateCustomerId(paddle, params.accountEmail);
  const customData =
    params.kind === "storage_addon"
      ? { accountEmail: params.accountEmail, kind: "storage_addon", gbAmount: params.gbAmount }
      : { accountEmail: params.accountEmail, kind: "tier", tier: params.tier };
  const transaction = await paddle.transactions.create({
    items: [{ priceId: params.priceId, quantity: 1 }],
    customerId,
    customData,
    // Explicit checkout.url avoids requiring a "default payment link" to be
    // configured in the Paddle dashboard (a real gap found 2026-07-22 while
    // testing the live checkout flow — Paddle rejects transaction creation
    // outright without either this or a dashboard-level default set).
    checkout: { url: "https://lazyrelay.com" },
  });
  return { transactionId: transaction.id, checkoutUrl: transaction.checkout?.url ?? null };
}
