import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  syncSubscriptionFromWebhook: vi.fn(),
  recordBillingEvent: vi.fn(),
  handleWalletBillingEvent: vi.fn(),
  handleWalletRefund: vi.fn(),
  order: [] as string[],
}));

vi.mock("../billing/sync.js", () => ({ syncSubscriptionFromWebhook: mocks.syncSubscriptionFromWebhook, recordBillingEvent: mocks.recordBillingEvent }));
vi.mock("../wallet/webhook.js", () => ({
  handleWalletBillingEvent: mocks.handleWalletBillingEvent,
  handleWalletRefund: mocks.handleWalletRefund,
  defaultWalletWebhookDeps: () => ({ fake: "deps" }),
}));

import { buildWebhookHandler } from "./webhook.js";
import type { BillingEvent, MerchantOfRecordAdapter } from "../billing/types.js";

function run(event: BillingEvent | null) {
  const adapter = { parseWebhookEvent: vi.fn().mockResolvedValue(event) } as unknown as MerchantOfRecordAdapter;
  const handler = buildWebhookHandler(adapter);
  const res: any = { statusCode: 0, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return handler({ headers: { "paddle-signature": "x" }, body: Buffer.from("{}") } as any, res).then(() => res);
}

const refundEvent: BillingEvent = { kind: "refund_record", paddleAdjustmentId: "adj_1", paddleTransactionId: "txn_1", paddleSubscriptionId: null, reason: "refund: x", currencyCode: "USD", subtotal: "1", tax: "0", total: "1", occurredAt: "2026-10-21T00:00:00.000Z" };
const tierEvent: BillingEvent = { kind: "tier", morSubscriptionId: "sub_1", accountEmail: "a@example.com", tier: "starter", status: "active", currentPeriodEnd: "2026-11-21T00:00:00.000Z", occurredAt: "2026-10-21T00:00:00.000Z", cancelAtPeriodEnd: false };
const packEvent: BillingEvent = { kind: "wallet_pack", eventId: "evt_1", sku: "lazycredits-starter-pack", accountId: "acct", paddleTransactionId: "txn_1", occurredAt: "2026-10-21T00:00:00.000Z" };
const planEvent: BillingEvent = { kind: "wallet_plan", phase: "lifecycle", eventId: "evt_2", sku: "lazyrelay-growth-plan", accountId: "acct", paddleSubscriptionId: "sub_1", subscription: { ...(tierEvent as any), tier: "growth" }, occurredAt: "2026-10-21T00:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.recordBillingEvent.mockImplementation(async () => { mocks.order.push("record"); });
  mocks.handleWalletRefund.mockImplementation(async () => { mocks.order.push("wallet"); return { outcome: "revoked" }; });
  mocks.handleWalletBillingEvent.mockResolvedValue({ outcome: "granted" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("the Paddle webhook handler with the wallet off (identical to today)", () => {
  beforeEach(() => vi.stubEnv("WALLET_ENABLED", ""));

  it("a tier event syncs the subscription and never touches the wallet", async () => {
    const res = await run(tierEvent);
    expect(res.statusCode).toBe(200);
    expect(mocks.syncSubscriptionFromWebhook).toHaveBeenCalledWith(tierEvent);
    expect(mocks.handleWalletBillingEvent).not.toHaveBeenCalled();
  });

  it("a refund is recorded and the wallet is not asked", async () => {
    const res = await run(refundEvent);
    expect(res.statusCode).toBe(200);
    expect(mocks.recordBillingEvent).toHaveBeenCalledTimes(1);
    expect(mocks.handleWalletRefund).not.toHaveBeenCalled();
  });

  it("an irrelevant event is still acknowledged and ignored", async () => {
    const res = await run(null);
    expect(res.body).toEqual({ received: true, ignored: true });
  });
});

describe("the Paddle webhook handler with the wallet on", () => {
  beforeEach(() => vi.stubEnv("WALLET_ENABLED", "true"));

  it("a refund is recorded first (it resolves the account) and then offered to the wallet", async () => {
    const res = await run(refundEvent);
    expect(res.statusCode).toBe(200);
    expect(mocks.order).toEqual(["record", "wallet"]);
  });

  it("a wallet pack goes to the wallet handler only", async () => {
    const res = await run(packEvent);
    expect(res.statusCode).toBe(200);
    expect(mocks.handleWalletBillingEvent).toHaveBeenCalledWith(packEvent, { fake: "deps" });
    expect(mocks.syncSubscriptionFromWebhook).not.toHaveBeenCalled();
  });

  it("a wallet plan event goes to the wallet handler (it runs the tier sync itself, in order)", async () => {
    const res = await run(planEvent);
    expect(res.statusCode).toBe(200);
    expect(mocks.handleWalletBillingEvent).toHaveBeenCalledWith(planEvent, { fake: "deps" });
    expect(mocks.syncSubscriptionFromWebhook).not.toHaveBeenCalled();
  });

  it("a wallet failure answers 500 so Paddle retries (never a silent 200)", async () => {
    mocks.handleWalletBillingEvent.mockRejectedValue(new Error("db down"));
    const res = await run(packEvent);
    expect(res.statusCode).toBe(500);
  });

  it("an old tier event still takes the old path", async () => {
    const res = await run(tierEvent);
    expect(res.statusCode).toBe(200);
    expect(mocks.syncSubscriptionFromWebhook).toHaveBeenCalledWith(tierEvent);
  });
});

describe("a wallet event that arrives with the switch off is still processed (a paid payment is never dropped)", () => {
  it("is handled", async () => {
    vi.stubEnv("WALLET_ENABLED", "");
    const res = await run(packEvent);
    expect(res.statusCode).toBe(200);
    expect(mocks.handleWalletBillingEvent).toHaveBeenCalled();
  });
});
