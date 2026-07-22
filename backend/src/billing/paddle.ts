import { Paddle, Environment } from "@paddle/paddle-node-sdk";
import type { MerchantOfRecordAdapter, SubscriptionEvent, CancelResult } from "./types.js";

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
//     interface had to change to Promise<SubscriptionEvent | null>.
// (2) `transactions.create()` requires a `customerId`, not an inline email —
//     Paddle has no "create transaction for arbitrary email" shortcut, so a
//     get-or-create Customer lookup is a required step, not a nicety.
//
// Event names confirmed from the SDK's own EventName enum: subscription
// lifecycle events are `subscription.created/activated/updated/past_due/
// paused/canceled/trialing/resumed/imported` (note: "canceled", one "l").
// Custom metadata field is `customData` (SDK) / `custom_data` (raw API),
// echoed back on every webhook — same synchronous-parsing-friendly design
// as the (now-removed) Stripe adapter: embed accountEmail+tier in
// customData at checkout-creation time so parsing itself needs no extra
// network call beyond the (already-async) signature verification.

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
]);

export const VALID_TIERS = ["free", "pro", "business"] as const;

interface SubscriptionLike {
  id: string;
  status: string;
  customData: Record<string, unknown> | null;
  currentBillingPeriod: { endsAt: string } | null;
}

function readCustomData(sub: SubscriptionLike): { accountEmail: string; tier: SubscriptionEvent["tier"] } {
  const customData = sub.customData ?? {};
  const accountEmail = customData.accountEmail;
  const tier = customData.tier;
  if (typeof accountEmail !== "string" || !accountEmail) {
    throw new Error(`Subscription ${sub.id} has no customData.accountEmail — was it created via buildCheckoutTransaction?`);
  }
  if (typeof tier !== "string" || !(VALID_TIERS as readonly string[]).includes(tier)) {
    throw new Error(`Subscription ${sub.id} has invalid/missing customData.tier "${String(tier)}"`);
  }
  return { accountEmail, tier: tier as SubscriptionEvent["tier"] };
}

export class PaddleMorAdapter implements MerchantOfRecordAdapter {
  private paddle: Paddle;

  constructor(apiKey: string, private webhookSecret: string, environment: Environment = Environment.production) {
    this.paddle = new Paddle(apiKey, { environment });
  }

  /** ASYNC — unlike the removed Stripe adapter, Paddle's own signature
   * verification (`webhooks.unmarshal`) is a Promise, so this had to become
   * one too (MerchantOfRecordAdapter's interface is `Promise<...>` for this
   * reason — see types.ts). Rejects/throws on invalid signature (Paddle's
   * unmarshal itself throws, never resolves to a falsy value on failure —
   * confirmed by reading the SDK's own .d.ts, which has no `| null` on its
   * return type). Returns null for a verified-but-irrelevant event. */
  async parseWebhookEvent(rawBody: string, signatureHeader: string): Promise<SubscriptionEvent | null> {
    const event = await this.paddle.webhooks.unmarshal(rawBody, this.webhookSecret, signatureHeader);

    if (!RELEVANT_EVENT_TYPES.has(event.eventType)) {
      // Transaction-side events, etc. — verified-legitimate, nothing to sync.
      return null;
    }

    const subscription = event.data as unknown as SubscriptionLike;
    const status = event.eventType === "subscription.canceled" ? "cancelled" : STATUS_MAP[subscription.status];
    if (!status) {
      throw new Error(`Unmapped Paddle subscription status "${subscription.status}" for ${subscription.id}`);
    }

    const { accountEmail, tier } = readCustomData(subscription);
    return {
      morSubscriptionId: subscription.id,
      accountEmail,
      tier,
      status,
      currentPeriodEnd: subscription.currentBillingPeriod?.endsAt ?? new Date().toISOString(),
    };
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

/** Creates a Paddle transaction to check out. Returns the transactionId,
 * which the frontend passes to Paddle.js's `Paddle.Checkout.open({
 * transactionId })` to render the real payment overlay on our own page —
 * Paddle Billing has no hosted Checkout Session page the way Stripe does;
 * checkout.url (kept below) only comes into play if Paddle.js itself fails
 * to load, as a plain-redirect fallback. There is no direct "create
 * subscription for a brand-new customer" call in Paddle Billing either — a
 * subscription is created by Paddle as a side effect of a completed
 * transaction, so this is the correct entry point, not a workaround. */
export async function buildCheckoutTransaction(
  apiKey: string,
  environment: Environment,
  params: { accountEmail: string; tier: "pro" | "business"; priceId: string }
): Promise<{ transactionId: string; checkoutUrl: string | null }> {
  const paddle = new Paddle(apiKey, { environment });
  const customerId = await getOrCreateCustomerId(paddle, params.accountEmail);
  const transaction = await paddle.transactions.create({
    items: [{ priceId: params.priceId, quantity: 1 }],
    customerId,
    customData: { accountEmail: params.accountEmail, tier: params.tier },
    // Explicit checkout.url avoids requiring a "default payment link" to be
    // configured in the Paddle dashboard (a real gap found 2026-07-22 while
    // testing the live checkout flow — Paddle rejects transaction creation
    // outright without either this or a dashboard-level default set).
    checkout: { url: "https://lazyrelay.com" },
  });
  return { transactionId: transaction.id, checkoutUrl: transaction.checkout?.url ?? null };
}
