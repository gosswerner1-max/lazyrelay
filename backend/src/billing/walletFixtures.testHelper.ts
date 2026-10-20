import { createHmac } from "node:crypto";

// Signed Paddle webhook fixtures for the wallet tests. Every id is a FAKE: the real price ids live in env vars and never in source.
// The body is real Paddle notification JSON (snake_case), signed the way Paddle signs it (ts=...;h1=hmac_sha256("ts:body")), so the
// real SDK verifies and parses it exactly as it does in production.

export const WEBHOOK_SECRET = "pdl_ntfset_fake_secret_for_tests";

export const FAKE_PRICES = {
  starterPack: "pri_fake_starter_pack",
  growthPack: "pri_fake_growth_pack",
  proTopUp: "pri_fake_pro_top_up",
  growthPlan: "pri_fake_growth_plan",
  proPlan: "pri_fake_pro_plan",
} as const;

export const WALLET_ENV: Record<string, string> = {
  WALLET_ENABLED: "true",
  WALLET_MODE: "on",
  PADDLE_PRICE_ID_LC_STARTER_PACK: FAKE_PRICES.starterPack,
  PADDLE_PRICE_ID_LC_GROWTH_PACK: FAKE_PRICES.growthPack,
  PADDLE_PRICE_ID_LC_PRO_TOPUP: FAKE_PRICES.proTopUp,
  PADDLE_PRICE_ID_GROWTH_PLAN: FAKE_PRICES.growthPlan,
  PADDLE_PRICE_ID_PRO_PLAN: FAKE_PRICES.proPlan,
};

export const ACCOUNT_ID = "6f1d0a52-3c1e-4e0a-9d6e-0b4b8d8f2a11";
export const NOW_ISO = "2026-10-21T10:00:00.000Z";
export const PERIOD_START = "2026-10-21T10:00:00.000Z";
export const PERIOD_END = "2026-11-21T10:00:00.000Z";

export function sign(body: string, secret: string = WEBHOOK_SECRET, ts: number = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

export function envelope(eventType: string, data: unknown, eventId = "evt_fake_1", occurredAt = NOW_ISO): string {
  return JSON.stringify({ event_id: eventId, event_type: eventType, occurred_at: occurredAt, notification_id: "ntf_fake_1", data });
}

function price(id: string) {
  return {
    id,
    product_id: "pro_fake",
    description: "fake",
    name: "fake",
    type: "standard",
    tax_mode: "account_setting",
    unit_price: { amount: "1500", currency_code: "USD" },
    quantity: { minimum: 1, maximum: 1 },
    status: "active",
    billing_cycle: null,
    trial_period: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
  };
}

const totals = {
  subtotal: "1500", discount: "0", tax: "0", total: "1500", credit: "0", credit_to_balance: "0", balance: "0",
  grand_total: "1500", grand_total_tax: "0", fee: "75", earnings: "1425", currency_code: "USD",
};

export interface TxnOptions {
  id?: string;
  priceId: string;
  customData?: Record<string, unknown> | null;
  subscriptionId?: string | null;
  billingPeriod?: { starts_at: string; ends_at: string } | null;
}

export function transactionData(o: TxnOptions) {
  return {
    id: o.id ?? "txn_fake_1",
    status: "completed",
    customer_id: "ctm_fake",
    address_id: "add_fake",
    business_id: null,
    custom_data: o.customData === undefined ? { account_id: ACCOUNT_ID } : o.customData,
    currency_code: "USD",
    origin: o.subscriptionId ? "subscription_recurring" : "web",
    subscription_id: o.subscriptionId ?? null,
    invoice_id: null,
    invoice_number: "1001-1",
    collection_mode: "automatic",
    discount_id: null,
    billing_details: null,
    billing_period: o.billingPeriod ?? null,
    items: [{ price: price(o.priceId), quantity: 1, proration: null }],
    details: {
      tax_rates_used: [],
      totals,
      adjusted_totals: null,
      payout_totals: { subtotal: "1500", discount: "0", tax: "0", total: "1500", credit: "0", credit_to_balance: "0", balance: "0", grand_total: "1500", grand_total_tax: "0", fee: "75", earnings: "1425", currency_code: "USD" },
      adjusted_payout_totals: null,
      line_items: [],
    },
    payments: [],
    checkout: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    billed_at: NOW_ISO,
    revised_at: null,
  };
}

export interface SubOptions {
  id?: string;
  status: "active" | "trialing" | "past_due" | "paused" | "canceled";
  priceId: string;
  customData?: Record<string, unknown> | null;
  scheduledChange?: { action: string; effective_at: string; resume_at: null } | null;
  periodEnd?: string | null;
}

export function subscriptionData(o: SubOptions) {
  return {
    id: o.id ?? "sub_fake_1",
    status: o.status,
    customer_id: "ctm_fake",
    address_id: "add_fake",
    business_id: null,
    currency_code: "USD",
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    started_at: NOW_ISO,
    first_billed_at: NOW_ISO,
    next_billed_at: PERIOD_END,
    paused_at: null,
    canceled_at: o.status === "canceled" ? NOW_ISO : null,
    discount: null,
    collection_mode: "automatic",
    billing_details: null,
    current_billing_period: o.periodEnd === null ? null : { starts_at: PERIOD_START, ends_at: o.periodEnd ?? PERIOD_END },
    billing_cycle: { interval: "month", frequency: 1 },
    scheduled_change: o.scheduledChange ?? null,
    items: [
      { status: "active", quantity: 1, recurring: true, created_at: NOW_ISO, updated_at: NOW_ISO, previously_billed_at: null, next_billed_at: PERIOD_END, trial_dates: null, price: price(o.priceId), product: null },
    ],
    custom_data: o.customData === undefined ? { account_id: ACCOUNT_ID } : o.customData,
    import_meta: null,
  };
}

export interface AdjOptions {
  id?: string;
  transactionId: string;
  subscriptionId?: string | null;
  action: "refund" | "chargeback" | "credit" | "chargeback_warning" | "chargeback_reverse";
  type?: "full" | "partial";
}

export function adjustmentData(o: AdjOptions) {
  return {
    id: o.id ?? "adj_fake_1",
    action: o.action,
    type: o.type ?? "full",
    transaction_id: o.transactionId,
    subscription_id: o.subscriptionId ?? null,
    customer_id: "ctm_fake",
    reason: "fake reason",
    credit_applied_to_balance: null,
    currency_code: "USD",
    status: "approved",
    items: [],
    totals: { subtotal: "1500", tax: "0", total: "1500", fee: "75", earnings: "1425", currency_code: "USD", retained_fee: "0" },
    payout_totals: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
  };
}
