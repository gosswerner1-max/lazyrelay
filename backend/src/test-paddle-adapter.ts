import crypto from "node:crypto";
import { PaddleMorAdapter } from "./billing/paddle.js";

// Verifies PaddleMorAdapter's parsing/mapping logic against a real,
// correctly-signed Paddle webhook payload — no live Paddle account needed,
// since signature verification is pure HMAC (confirmed by reading
// WebhooksValidator's own source: HMAC-SHA256 over "${ts}:${rawBody}",
// header format "ts=<epoch>;h1=<hex>", timestamp must be within 5 seconds
// of "now"). This is what's testable before a real Paddle account exists;
// the actual checkout-transaction creation and cancellation calls DO need
// a real account and are not covered here.

const WEBHOOK_SECRET = "pdl_ntfset_test_secret";

function signPayload(rawBody: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const h1 = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${ts}:${rawBody}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

function fakeSubscriptionNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_test123",
    status: "active",
    customer_id: "ctm_test",
    address_id: "add_test",
    currency_code: "USD",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    collection_mode: "automatic",
    billing_cycle: { interval: "month", frequency: 1 },
    items: [],
    custom_data: { accountEmail: "customer@example.com", tier: "pro" },
    current_billing_period: { starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() },
    ...overrides,
  };
}

function fakeTransactionNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: "txn_test",
    status: "completed",
    currency_code: "USD",
    origin: "api",
    collection_mode: "automatic",
    subscription_id: "sub_test123",
    invoice_number: "INV-0001",
    custom_data: { accountEmail: "customer@example.com", kind: "tier", tier: "pro" },
    items: [],
    payments: [],
    details: {
      tax_rates_used: [],
      line_items: [],
      totals: { subtotal: "48.99", discount: "0.00", tax: "7.35", total: "56.34", credit: "0.00", credit_to_balance: "0.00", balance: "0.00", grand_total: "56.34", grand_total_tax: "7.35", currency_code: "USD" },
      payout_totals: { subtotal: "48.99", discount: "0.00", tax: "7.35", total: "56.34", credit: "0.00", balance: "0.00", grand_total: "56.34", grand_total_tax: "7.35", credit_to_balance: "0.00", fee: "3.50", earnings: "52.84", currency_code: "USD", exchange_rate: "1", fee_rate: "0.06" },
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    billed_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeAdjustmentNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: "adj_test",
    action: "refund",
    type: "full",
    transaction_id: "txn_test",
    subscription_id: "sub_test123",
    customer_id: "ctm_test",
    reason: "requested_by_customer",
    credit_applied_to_balance: false,
    currency_code: "USD",
    status: "approved",
    items: [],
    totals: { subtotal: "48.99", tax: "7.35", total: "56.34", fee: "3.50", earnings: "52.84", currency_code: "USD", retained_fee: "0.00" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildEventPayload(eventType: string, data: object): string {
  return JSON.stringify({
    event_id: "evt_test",
    notification_id: "ntf_test",
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    data,
  });
}

function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  return fn()
    .then(() => {
      console.log(`PASS: ${name}`);
      return true;
    })
    .catch((err) => {
      console.log(`FAIL: ${name} — ${err instanceof Error ? err.message : err}`);
      return false;
    });
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const adapter = new PaddleMorAdapter("pdl_test_dummy_not_used_for_network_calls", WEBHOOK_SECRET);

async function main() {
  const results = await Promise.all([
    test("subscription.created (active) maps correctly", async () => {
      const rawBody = buildEventPayload("subscription.created", fakeSubscriptionNotification({ status: "active" }));
      const event = await adapter.parseWebhookEvent(rawBody, signPayload(rawBody));
      assertEqual(event && "status" in event ? event.status : undefined, "active", "status");
      assertEqual(event && "tier" in event ? event.tier : undefined, "pro", "tier");
      assertEqual(event && "accountEmail" in event ? event.accountEmail : undefined, "customer@example.com", "accountEmail");
      assertEqual(event && "morSubscriptionId" in event ? event.morSubscriptionId : undefined, "sub_test123", "morSubscriptionId");
    }),

    test("subscription.updated (past_due) maps correctly", async () => {
      const rawBody = buildEventPayload(
        "subscription.updated",
        fakeSubscriptionNotification({ status: "past_due", custom_data: { accountEmail: "x@example.com", tier: "business" } })
      );
      const event = await adapter.parseWebhookEvent(rawBody, signPayload(rawBody));
      assertEqual(event && "status" in event ? event.status : undefined, "past_due", "status");
      assertEqual(event && "tier" in event ? event.tier : undefined, "business", "tier");
    }),

    test("subscription.paused maps to past_due (payment-lapse state, not full cancellation)", async () => {
      const rawBody = buildEventPayload("subscription.paused", fakeSubscriptionNotification({ status: "paused" }));
      const event = await adapter.parseWebhookEvent(rawBody, signPayload(rawBody));
      assertEqual(event && "status" in event ? event.status : undefined, "past_due", "status");
    }),

    test("subscription.canceled maps to cancelled regardless of Paddle's own status field", async () => {
      const rawBody = buildEventPayload("subscription.canceled", fakeSubscriptionNotification({ status: "canceled" }));
      const event = await adapter.parseWebhookEvent(rawBody, signPayload(rawBody));
      assertEqual(event && "status" in event ? event.status : undefined, "cancelled", "status");
    }),

    test("irrelevant event type (customer.created) returns null, not an error", async () => {
      const rawBody = buildEventPayload("customer.created", { id: "ctm_test", email: "customer@example.com" });
      const event = await adapter.parseWebhookEvent(rawBody, signPayload(rawBody));
      assertEqual(event, null, "event");
    }),

    test("transaction.completed builds a sale_record with sale + payout totals", async () => {
      const rawBody = buildEventPayload("transaction.completed", fakeTransactionNotification());
      const event = await adapter.parseWebhookEvent(rawBody, signPayload(rawBody));
      assertEqual(event?.kind, "sale_record", "kind");
      assertEqual(event && "accountEmail" in event ? event.accountEmail : undefined, "customer@example.com", "accountEmail");
      assertEqual(event && "paddleTransactionId" in event ? event.paddleTransactionId : undefined, "txn_test", "paddleTransactionId");
      assertEqual(event && "invoiceNumber" in event ? event.invoiceNumber : undefined, "INV-0001", "invoiceNumber");
      assertEqual(event && "total" in event ? event.total : undefined, "56.34", "total");
      assertEqual(event && "payoutEarnings" in event ? event.payoutEarnings : undefined, "52.84", "payoutEarnings");
    }),

    test("transaction.completed with no customData.accountEmail throws a clear error", async () => {
      const rawBody = buildEventPayload("transaction.completed", fakeTransactionNotification({ custom_data: null }));
      let threw = false;
      try {
        await adapter.parseWebhookEvent(rawBody, signPayload(rawBody));
      } catch (err) {
        threw = err instanceof Error && err.message.includes("accountEmail");
      }
      if (!threw) throw new Error("expected a clear error mentioning accountEmail");
    }),

    test("adjustment.created builds a refund_record linked to its transaction", async () => {
      const rawBody = buildEventPayload("adjustment.created", fakeAdjustmentNotification());
      const event = await adapter.parseWebhookEvent(rawBody, signPayload(rawBody));
      assertEqual(event?.kind, "refund_record", "kind");
      assertEqual(event && "paddleTransactionId" in event ? event.paddleTransactionId : undefined, "txn_test", "paddleTransactionId");
      assertEqual(event && "paddleAdjustmentId" in event ? event.paddleAdjustmentId : undefined, "adj_test", "paddleAdjustmentId");
      assertEqual(event && "reason" in event ? event.reason : undefined, "refund: requested_by_customer", "reason");
      assertEqual(event && "total" in event ? event.total : undefined, "56.34", "total");
    }),

    test("bad signature throws, never silently accepted", async () => {
      const rawBody = buildEventPayload("subscription.created", fakeSubscriptionNotification());
      let threw = false;
      try {
        await adapter.parseWebhookEvent(rawBody, "ts=1;h1=deadbeef");
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("expected a forged signature to throw, but it didn't");
    }),

    test("subscription missing custom_data.accountEmail throws a clear error", async () => {
      const rawBody = buildEventPayload("subscription.created", fakeSubscriptionNotification({ custom_data: { tier: "pro" } }));
      let threw = false;
      try {
        await adapter.parseWebhookEvent(rawBody, signPayload(rawBody));
      } catch (err) {
        threw = err instanceof Error && err.message.includes("accountEmail");
      }
      if (!threw) throw new Error("expected a clear error mentioning accountEmail");
    }),
  ]);

  console.log(results.every(Boolean) ? "\nALL PASS" : "\nSOME FAILED");
  process.exit(results.every(Boolean) ? 0 : 1);
}

main();
