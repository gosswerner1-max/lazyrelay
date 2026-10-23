import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleWalletBillingEvent, handleWalletRefund, type WalletWebhookDeps } from "./webhook.js";
import { SKU } from "./catalog.js";
import type { RefundRecordEvent, SaleRecordEvent, WalletPackEvent, WalletPlanLifecycleEvent, WalletPlanPaymentEvent, SubscriptionEvent } from "../billing/types.js";

const ACCOUNT = "6f1d0a52-3c1e-4e0a-9d6e-0b4b8d8f2a11";
const NOW = new Date("2026-10-21T10:05:00.000Z");
const PERIOD_END = "2026-11-21T10:00:00.000Z";

const sale: SaleRecordEvent = {
  kind: "sale_record", accountEmail: "", accountId: ACCOUNT, paddleTransactionId: "txn_1", paddleSubscriptionId: null, invoiceNumber: null, currencyCode: "USD",
  subtotal: "1500", tax: "0", total: "1500", grandTotal: "1500", payoutCurrencyCode: null, payoutSubtotal: null, payoutTax: null, payoutFee: null, payoutEarnings: null, occurredAt: "2026-10-21T10:00:00.000Z",
};

const packEvent = (over: Partial<WalletPackEvent> = {}): WalletPackEvent => ({
  kind: "wallet_pack", eventId: "evt_1", sku: SKU.starterPack, accountId: ACCOUNT, paddleTransactionId: "txn_1", occurredAt: "2026-10-21T10:00:00.000Z", sale, ...over,
});
const paymentEvent = (over: Partial<WalletPlanPaymentEvent> = {}): WalletPlanPaymentEvent => ({
  kind: "wallet_plan", phase: "payment", eventId: "evt_2", sku: SKU.growthPlan, accountId: ACCOUNT, paddleTransactionId: "txn_2", paddleSubscriptionId: "sub_1", periodEnd: PERIOD_END, occurredAt: "2026-10-21T10:00:00.000Z", sale, ...over,
});
const subscription = (over: Partial<SubscriptionEvent> = {}): SubscriptionEvent => ({
  kind: "tier", morSubscriptionId: "sub_1", accountEmail: "", accountId: ACCOUNT, tier: "growth", status: "active", currentPeriodEnd: PERIOD_END, occurredAt: "2026-10-21T10:00:00.000Z", cancelAtPeriodEnd: false, ...over,
});
const lifecycle = (sub: Partial<SubscriptionEvent> = {}, over: Partial<WalletPlanLifecycleEvent> = {}): WalletPlanLifecycleEvent => ({
  kind: "wallet_plan", phase: "lifecycle", eventId: "evt_3", sku: SKU.growthPlan, accountId: ACCOUNT, paddleSubscriptionId: "sub_1", subscription: subscription(sub), occurredAt: "2026-10-21T10:00:00.000Z", ...over,
});
const refund = (action: string, type: "full" | "partial" = "full"): RefundRecordEvent => ({
  kind: "refund_record", paddleAdjustmentId: "adj_1", paddleTransactionId: "txn_2", paddleSubscriptionId: "sub_1", reason: `${action}: customer asked`, currencyCode: "USD",
  subtotal: "2900", tax: "0", total: "2900", occurredAt: "2026-10-21T11:00:00.000Z", adjustmentType: type,
});

const grantOk = { ok: true as const, replay: false, lotId: "11111111-1111-4111-8111-111111111111", grantedMicro: 300_000_000, balanceMicro: 300_000_000 };

let deps: WalletWebhookDeps;
let ledger: { grantForSku: ReturnType<typeof vi.fn>; handlePlanEvent: ReturnType<typeof vi.fn> };
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ledger = { grantForSku: vi.fn().mockResolvedValue(grantOk), handlePlanEvent: vi.fn().mockResolvedValue({ ok: true, replay: false, lotsRevoked: 1, expiredMicro: 5 }) };
  deps = {
    ledger: ledger as unknown as WalletWebhookDeps["ledger"],
    now: () => NOW,
    activePlan: vi.fn().mockResolvedValue(null),
    accountForSubscription: vi.fn().mockResolvedValue(null),
    lotForTransaction: vi.fn().mockResolvedValue(null),
    syncSubscription: vi.fn().mockResolvedValue(undefined),
    recordSale: vi.fn().mockResolvedValue(undefined),
    alert: vi.fn().mockResolvedValue(undefined),
    partnerAttribution: { hasPriorSale: vi.fn().mockResolvedValue(false), record: vi.fn().mockResolvedValue(undefined) },
  };
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a pack purchase", () => {
  it("records the sale, then grants a never expiring lot keyed by the Paddle transaction id", async () => {
    const out = await handleWalletBillingEvent(packEvent(), deps);
    expect(out.outcome).toBe("granted");
    expect(deps.recordSale).toHaveBeenCalledWith(sale);
    expect(ledger.grantForSku).toHaveBeenCalledWith({ accountId: ACCOUNT, sku: SKU.starterPack, sourceKey: "paddle:txn_1", now: NOW, activePlan: null });
    expect(ledger.grantForSku.mock.calls[0][0].periodEnd).toBeUndefined();
  });

  it("a replayed webhook uses the same key and grants nothing twice", async () => {
    const seen = new Set<string>();
    ledger.grantForSku.mockImplementation(async (i: { sourceKey: string }) => {
      const replay = seen.has(i.sourceKey);
      seen.add(i.sourceKey);
      return { ...grantOk, replay };
    });
    const a = await handleWalletBillingEvent(packEvent(), deps);
    const b = await handleWalletBillingEvent(packEvent({ eventId: "evt_other_delivery" }), deps);
    expect(a.outcome).toBe("granted");
    expect(b.outcome).toBe("replay");
    expect(ledger.grantForSku.mock.calls[0][0].sourceKey).toBe(ledger.grantForSku.mock.calls[1][0].sourceKey);
    expect(seen.size).toBe(1);
  });

  it("the Pro top up is granted to an active Pro plan, with the plan passed to the database gate", async () => {
    (deps.activePlan as ReturnType<typeof vi.fn>).mockResolvedValue("pro");
    const out = await handleWalletBillingEvent(packEvent({ sku: SKU.proTopUp }), deps);
    expect(out.outcome).toBe("granted");
    expect(ledger.grantForSku).toHaveBeenCalledWith(expect.objectContaining({ sku: SKU.proTopUp, activePlan: "pro" }));
  });

  it("the Pro top up without an active Pro plan is refused: raw error logged, ops told, queued for a manual refund, never thrown or dropped", async () => {
    ledger.grantForSku.mockResolvedValue({ ok: false, reason: "plan_required", requiredPlan: "pro" });
    const out = await handleWalletBillingEvent(packEvent({ sku: SKU.proTopUp }), deps);
    expect(out.outcome).toBe("refused_plan_required");
    expect(errorSpy).toHaveBeenCalled();
    const message = (deps.alert as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(message).toContain("manual refund");
    expect(message).toContain("txn_1");
    expect(message).toContain(ACCOUNT);
    expect(message).toContain(SKU.proTopUp);
  });

  it("a pack that names no account is alerted for a manual look, never silently dropped", async () => {
    const out = await handleWalletBillingEvent(packEvent({ accountId: undefined }), deps);
    expect(out.outcome).toBe("unattributed");
    expect(ledger.grantForSku).not.toHaveBeenCalled();
    expect((deps.alert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("txn_1");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("a database failure is thrown (the webhook answers 500 and Paddle retries), never swallowed", async () => {
    ledger.grantForSku.mockRejectedValue(new Error("the wallet is not available right now"));
    await expect(handleWalletBillingEvent(packEvent(), deps)).rejects.toThrow(/not available/);
  });
});

describe("a plan payment (first month or renewal)", () => {
  it("grants the monthly lot expiring at the period end, keyed by the transaction id", async () => {
    const out = await handleWalletBillingEvent(paymentEvent(), deps);
    expect(out.outcome).toBe("granted");
    expect(deps.recordSale).toHaveBeenCalledWith(sale);
    expect(ledger.grantForSku).toHaveBeenCalledWith({ accountId: ACCOUNT, sku: SKU.growthPlan, sourceKey: "paddle:txn_2", now: NOW, activePlan: null, periodEnd: new Date(PERIOD_END) });
  });

  it("a renewal is a different transaction id, so it grants again; a replay of the same one does not", async () => {
    await handleWalletBillingEvent(paymentEvent({ paddleTransactionId: "txn_3" }), deps);
    expect(ledger.grantForSku.mock.calls[0][0].sourceKey).toBe("paddle:txn_3");
  });

  it("finds the account from the subscription when the renewal carries no custom data", async () => {
    (deps.accountForSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(ACCOUNT);
    const out = await handleWalletBillingEvent(paymentEvent({ accountId: undefined }), deps);
    expect(out.outcome).toBe("granted");
    expect(deps.accountForSubscription).toHaveBeenCalledWith("sub_1");
    expect(ledger.grantForSku).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT }));
  });

  it("no account anywhere: alerted, never dropped", async () => {
    const out = await handleWalletBillingEvent(paymentEvent({ accountId: undefined }), deps);
    expect(out.outcome).toBe("unattributed");
    expect(deps.alert).toHaveBeenCalled();
  });

  it("a payment with no billing period is an error, not a guess", async () => {
    await expect(handleWalletBillingEvent(paymentEvent({ periodEnd: undefined }), deps)).rejects.toThrow(/billing period/);
  });

  it("a period that already ended grants nothing", async () => {
    const out = await handleWalletBillingEvent(paymentEvent({ periodEnd: "2026-10-01T00:00:00.000Z" }), deps);
    expect(out.outcome).toBe("skipped_period_over");
    expect(ledger.grantForSku).not.toHaveBeenCalled();
  });
});

describe("subscription lifecycle", () => {
  it("activation stores the tier through the existing sync path and grants nothing (the payment grants)", async () => {
    const ev = lifecycle();
    const out = await handleWalletBillingEvent(ev, deps);
    expect(out.outcome).toBe("synced");
    expect(deps.syncSubscription).toHaveBeenCalledWith(ev.subscription);
    expect(ledger.grantForSku).not.toHaveBeenCalled();
    expect(ledger.handlePlanEvent).not.toHaveBeenCalled();
  });

  it("past_due does NOT lapse: the database is told past_due_retry and answers no_lapse", async () => {
    ledger.handlePlanEvent.mockResolvedValue({ ok: true, outcome: "no_lapse" });
    const out = await handleWalletBillingEvent(lifecycle({ status: "past_due" }), deps);
    expect(out.outcome).toBe("no_lapse");
    expect(deps.syncSubscription).toHaveBeenCalled();
    expect(ledger.handlePlanEvent).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT, plan: "growth", event: "past_due_retry" }));
  });

  it("a voluntary cancel keeps the plan until the period end: the scheduled cancel only syncs the flag", async () => {
    const out = await handleWalletBillingEvent(lifecycle({ status: "active", cancelAtPeriodEnd: true }), deps);
    expect(out.outcome).toBe("synced");
    expect(deps.syncSubscription).toHaveBeenCalledWith(expect.objectContaining({ cancelAtPeriodEnd: true, status: "active" }));
    expect(ledger.handlePlanEvent).not.toHaveBeenCalled();
  });

  it("subscription.canceled (it arrives at the period end) lapses the plan's credits through wallet_handle_plan_event", async () => {
    const out = await handleWalletBillingEvent(lifecycle({ status: "cancelled" }), deps);
    expect(out.outcome).toBe("lapsed");
    expect(ledger.handlePlanEvent).toHaveBeenCalledWith({ accountId: ACCOUNT, plan: "growth", event: "billing_gave_up", idempotencyKey: "cancel:sub_1", now: NOW });
  });

  it("the Pro plan lapses the wallet plan named pro", async () => {
    await handleWalletBillingEvent(lifecycle({ status: "cancelled", tier: "lazy_pro" }, { sku: SKU.proPlan }), deps);
    expect(ledger.handlePlanEvent).toHaveBeenCalledWith(expect.objectContaining({ plan: "pro" }));
  });

  it("a failed tier sync stops everything: no wallet call, the error is thrown for a retry", async () => {
    (deps.syncSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    await expect(handleWalletBillingEvent(lifecycle({ status: "cancelled" }), deps)).rejects.toThrow(/db down/);
    expect(ledger.handlePlanEvent).not.toHaveBeenCalled();
  });
});

describe("refunds and chargebacks", () => {
  it("a full refund of a plan payment revokes the plan's credits immediately", async () => {
    (deps.lotForTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({ accountId: ACCOUNT, kind: "subscription", boundPlan: "growth" });
    const out = await handleWalletRefund(refund("refund"), deps);
    expect(out.outcome).toBe("revoked");
    expect(deps.lotForTransaction).toHaveBeenCalledWith("txn_2");
    expect(ledger.handlePlanEvent).toHaveBeenCalledWith({ accountId: ACCOUNT, plan: "growth", event: "refund", idempotencyKey: "adj:adj_1", now: NOW });
  });

  it("a chargeback uses the chargeback event", async () => {
    (deps.lotForTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({ accountId: ACCOUNT, kind: "subscription", boundPlan: "pro" });
    await handleWalletRefund(refund("chargeback"), deps);
    expect(ledger.handlePlanEvent).toHaveBeenCalledWith(expect.objectContaining({ plan: "pro", event: "chargeback" }));
  });

  it("a partial refund never cancels a plan: ops are told", async () => {
    (deps.lotForTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({ accountId: ACCOUNT, kind: "subscription", boundPlan: "growth" });
    const out = await handleWalletRefund(refund("refund", "partial"), deps);
    expect(out.outcome).toBe("alerted");
    expect(ledger.handlePlanEvent).not.toHaveBeenCalled();
    expect(deps.alert).toHaveBeenCalled();
  });

  it("a refund on a credit pack raises an ops alert only (v1): credits are not clawed back", async () => {
    (deps.lotForTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({ accountId: ACCOUNT, kind: "pack", boundPlan: null });
    const out = await handleWalletRefund(refund("refund"), deps);
    expect(out.outcome).toBe("alerted");
    expect(ledger.handlePlanEvent).not.toHaveBeenCalled();
    expect((deps.alert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("txn_2");
  });

  it("a refund of something that is not a wallet payment is ignored here (the old path handles it)", async () => {
    const out = await handleWalletRefund(refund("refund"), deps);
    expect(out.outcome).toBe("not_wallet");
    expect(deps.alert).not.toHaveBeenCalled();
    expect(ledger.handlePlanEvent).not.toHaveBeenCalled();
  });

  it("a chargeback warning or reversal changes nothing", async () => {
    (deps.lotForTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({ accountId: ACCOUNT, kind: "subscription", boundPlan: "growth" });
    expect((await handleWalletRefund(refund("chargeback_warning"), deps)).outcome).toBe("ignored");
    expect((await handleWalletRefund(refund("chargeback_reverse"), deps)).outcome).toBe("ignored");
    expect(ledger.handlePlanEvent).not.toHaveBeenCalled();
  });

  it("a replayed refund webhook revokes once: the same key, and the database answers replay", async () => {
    (deps.lotForTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({ accountId: ACCOUNT, kind: "subscription", boundPlan: "growth" });
    ledger.handlePlanEvent.mockResolvedValue({ ok: true, replay: true, lotsRevoked: 1, expiredMicro: 5 });
    const out = await handleWalletRefund(refund("refund"), deps);
    expect(out.outcome).toBe("replay");
  });
});

describe("partner attribution on a first ever paid purchase (affiliate)", () => {
  const attribution = () => deps.partnerAttribution as unknown as { hasPriorSale: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn> };

  it("a first ever pack purchase with a partner code records the attribution, asking about OTHER sales than this transaction", async () => {
    await handleWalletBillingEvent(packEvent({ partnerCode: "sarah" }), deps);
    expect(attribution().hasPriorSale).toHaveBeenCalledWith(ACCOUNT, "txn_1");
    expect(attribution().record).toHaveBeenCalledWith(ACCOUNT, "sarah");
  });

  it("a first ever plan payment with a partner code records the attribution", async () => {
    await handleWalletBillingEvent(paymentEvent({ partnerCode: "sarah" }), deps);
    expect(attribution().hasPriorSale).toHaveBeenCalledWith(ACCOUNT, "txn_2");
    expect(attribution().record).toHaveBeenCalledWith(ACCOUNT, "sarah");
  });

  it("the prior sale check happens BEFORE the sale is booked, and the attribution is recorded after it", async () => {
    const order: string[] = [];
    (deps.recordSale as ReturnType<typeof vi.fn>).mockImplementation(async () => void order.push("sale"));
    attribution().hasPriorSale.mockImplementation(async () => (order.push("check"), false));
    attribution().record.mockImplementation(async () => void order.push("record"));
    await handleWalletBillingEvent(packEvent({ partnerCode: "sarah" }), deps);
    expect(order).toEqual(["check", "sale", "record"]);
  });

  it("a customer who already paid before is not attributed (not their first purchase)", async () => {
    attribution().hasPriorSale.mockResolvedValue(true);
    await handleWalletBillingEvent(packEvent({ partnerCode: "sarah" }), deps);
    expect(attribution().record).not.toHaveBeenCalled();
  });

  it("a renewal of the same plan carries the code but is never a first purchase", async () => {
    attribution().hasPriorSale.mockResolvedValue(true);
    await handleWalletBillingEvent(paymentEvent({ paddleTransactionId: "txn_9", partnerCode: "sarah" }), deps);
    expect(attribution().record).not.toHaveBeenCalled();
  });

  it("no partner code: nothing is checked or recorded", async () => {
    await handleWalletBillingEvent(packEvent(), deps);
    expect(attribution().hasPriorSale).not.toHaveBeenCalled();
    expect(attribution().record).not.toHaveBeenCalled();
  });

  it("an attribution failure is thrown, so the webhook answers 500 and Paddle retries; the credits were already granted (idempotent key)", async () => {
    attribution().record.mockRejectedValue(new Error("write failed"));
    await expect(handleWalletBillingEvent(packEvent({ partnerCode: "sarah" }), deps)).rejects.toThrow(/write failed/);
    expect(ledger.grantForSku).toHaveBeenCalledTimes(1);
  });

  it("the retry still counts as the first purchase (its own sale is excluded) and records the attribution", async () => {
    attribution().record.mockRejectedValueOnce(new Error("write failed"));
    await expect(handleWalletBillingEvent(packEvent({ partnerCode: "sarah" }), deps)).rejects.toThrow();
    const out = await handleWalletBillingEvent(packEvent({ partnerCode: "sarah" }), deps);
    expect(out.outcome).toBe("granted");
    expect(attribution().hasPriorSale).toHaveBeenLastCalledWith(ACCOUNT, "txn_1");
    expect(attribution().record).toHaveBeenCalledTimes(2);
  });

  it("a failure of the first purchase check is thrown before anything is booked, so the retry starts clean", async () => {
    attribution().hasPriorSale.mockRejectedValue(new Error("db down"));
    await expect(handleWalletBillingEvent(packEvent({ partnerCode: "sarah" }), deps)).rejects.toThrow(/db down/);
    expect(deps.recordSale).not.toHaveBeenCalled();
    expect(ledger.grantForSku).not.toHaveBeenCalled();
  });

  it("a pack that was paid but refused for lacking a plan is still the customer's first paid purchase, so it still attributes", async () => {
    ledger.grantForSku.mockResolvedValue({ ok: false, reason: "plan_required", requiredPlan: "pro" });
    const out = await handleWalletBillingEvent(packEvent({ sku: SKU.proTopUp, partnerCode: "sarah" }), deps);
    expect(out.outcome).toBe("refused_plan_required");
    expect(attribution().record).toHaveBeenCalledWith(ACCOUNT, "sarah");
  });
});
