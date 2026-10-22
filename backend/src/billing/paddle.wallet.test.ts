import { describe, it, expect, vi } from "vitest";
import { Environment } from "@paddle/paddle-node-sdk";
import { PaddleMorAdapter } from "./paddle.js";
import { WebhookSignatureError } from "./types.js";
import { SKU } from "../wallet/catalog.js";
import {
  ACCOUNT_ID, FAKE_PRICES, PERIOD_END, PERIOD_START, WALLET_ENV, WEBHOOK_SECRET,
  adjustmentData, envelope, sign, subscriptionData, transactionData,
} from "./walletFixtures.testHelper.js";

function adapter(env: Record<string, string | undefined> = WALLET_ENV) {
  return new PaddleMorAdapter("fake_api_key", WEBHOOK_SECRET, Environment.sandbox, env);
}
async function parse(a: PaddleMorAdapter, type: string, data: unknown, eventId = "evt_fake_1") {
  const body = envelope(type, data, eventId);
  return a.parseWebhookEvent(body, sign(body));
}

describe("wallet pack purchases (transaction.completed on a one time price)", () => {
  it("a Starter Pack becomes a wallet_pack event with the account from the transaction custom data", async () => {
    const ev = await parse(adapter(), "transaction.completed", transactionData({ priceId: FAKE_PRICES.starterPack, customData: { account_id: ACCOUNT_ID, sku: SKU.starterPack } }));
    expect(ev).toMatchObject({ kind: "wallet_pack", sku: SKU.starterPack, accountId: ACCOUNT_ID, paddleTransactionId: "txn_fake_1", eventId: "evt_fake_1" });
    expect((ev as any).sale).toMatchObject({ kind: "sale_record", accountId: ACCOUNT_ID, paddleTransactionId: "txn_fake_1" });
  });

  it("the sku comes from the PRICE ID, not from custom data a buyer could have altered", async () => {
    const ev = await parse(adapter(), "transaction.completed", transactionData({ priceId: FAKE_PRICES.growthPack, customData: { account_id: ACCOUNT_ID, sku: SKU.proTopUp } }));
    expect(ev).toMatchObject({ kind: "wallet_pack", sku: SKU.growthPack });
  });

  it("the Pro top up is a wallet_pack too (the plan gate is applied when it is granted)", async () => {
    const ev = await parse(adapter(), "transaction.completed", transactionData({ priceId: FAKE_PRICES.proTopUp }));
    expect(ev).toMatchObject({ kind: "wallet_pack", sku: SKU.proTopUp });
  });

  it("a pack with no account in its custom data still parses, with accountId undefined, so it can be alerted and never dropped", async () => {
    const ev = await parse(adapter(), "transaction.completed", transactionData({ priceId: FAKE_PRICES.starterPack, customData: null }));
    expect(ev).toMatchObject({ kind: "wallet_pack", accountId: undefined });
  });
});

describe("wallet plan payments and subscription lifecycle", () => {
  it("a plan payment (first or renewal) is a wallet_plan payment event carrying the billing period", async () => {
    const ev = await parse(adapter(), "transaction.completed", transactionData({ id: "txn_fake_2", priceId: FAKE_PRICES.proPlan, subscriptionId: "sub_fake_1", billingPeriod: { starts_at: PERIOD_START, ends_at: PERIOD_END } }));
    expect(ev).toMatchObject({ kind: "wallet_plan", phase: "payment", sku: SKU.proPlan, paddleTransactionId: "txn_fake_2", paddleSubscriptionId: "sub_fake_1", accountId: ACCOUNT_ID, periodEnd: PERIOD_END });
  });

  it.each([
    ["subscription.created", "active", "active"],
    ["subscription.activated", "active", "active"],
    ["subscription.updated", "active", "active"],
    ["subscription.past_due", "past_due", "past_due"],
    ["subscription.paused", "paused", "past_due"],
    ["subscription.canceled", "canceled", "cancelled"],
  ] as const)("%s becomes a wallet_plan lifecycle event with a growth tier subscription", async (type, paddleStatus, status) => {
    const ev: any = await parse(adapter(), type, subscriptionData({ status: paddleStatus, priceId: FAKE_PRICES.growthPlan }));
    expect(ev).toMatchObject({ kind: "wallet_plan", phase: "lifecycle", sku: SKU.growthPlan, accountId: ACCOUNT_ID });
    expect(ev.subscription).toMatchObject({ kind: "tier", tier: "growth", status, accountId: ACCOUNT_ID, morSubscriptionId: "sub_fake_1", currentPeriodEnd: PERIOD_END });
  });

  it("the Pro plan sets the lazy_pro tier, never the old pro tier", async () => {
    const ev: any = await parse(adapter(), "subscription.activated", subscriptionData({ status: "active", priceId: FAKE_PRICES.proPlan }));
    expect(ev.subscription.tier).toBe("lazy_pro");
  });

  it("a scheduled cancel (status still active) is carried as cancelAtPeriodEnd", async () => {
    const ev: any = await parse(adapter(), "subscription.updated", subscriptionData({ status: "active", priceId: FAKE_PRICES.growthPlan, scheduledChange: { action: "cancel", effective_at: PERIOD_END, resume_at: null } }));
    expect(ev.subscription).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
  });
});

describe("refunds", () => {
  it("adjustment.created keeps the old refund_record and now also names the adjustment type", async () => {
    const ev = await parse(adapter(), "adjustment.created", adjustmentData({ transactionId: "txn_fake_1", action: "refund", type: "partial" }));
    expect(ev).toMatchObject({ kind: "refund_record", paddleAdjustmentId: "adj_fake_1", paddleTransactionId: "txn_fake_1", adjustmentType: "partial" });
  });
});

describe("everything else is unchanged", () => {
  it("an unknown price id on a transaction falls through to the old sale record path", async () => {
    const ev = await parse(adapter(), "transaction.completed", transactionData({ priceId: "pri_old_tier", customData: { accountEmail: "a@example.com", accountId: ACCOUNT_ID, kind: "tier", tier: "starter" } }));
    expect(ev).toMatchObject({ kind: "sale_record", accountEmail: "a@example.com", paddleTransactionId: "txn_fake_1" });
  });

  it("an unknown price id on a subscription falls through to the old six tier path", async () => {
    const ev = await parse(adapter(), "subscription.activated", subscriptionData({ status: "active", priceId: "pri_old_tier", customData: { accountEmail: "a@example.com", accountId: ACCOUNT_ID, kind: "tier", tier: "starter" } }));
    expect(ev).toMatchObject({ kind: "tier", tier: "starter", status: "active", accountEmail: "a@example.com" });
  });

  it("with the wallet off, even a wallet price id takes the old path (flag off is identical to today)", async () => {
    const off = { ...WALLET_ENV, WALLET_ENABLED: undefined };
    const ev = await parse(adapter(off), "transaction.completed", transactionData({ priceId: FAKE_PRICES.starterPack, customData: { accountEmail: "a@example.com", accountId: ACCOUNT_ID } }));
    expect(ev).toMatchObject({ kind: "sale_record", accountEmail: "a@example.com" });
    await expect(parse(adapter(off), "transaction.completed", transactionData({ priceId: FAKE_PRICES.starterPack, customData: { account_id: ACCOUNT_ID, sku: SKU.starterPack } }))).rejects.toThrow(/accountEmail/);
  });

  it("a forged signature is still a WebhookSignatureError", async () => {
    const body = envelope("transaction.completed", transactionData({ priceId: FAKE_PRICES.starterPack }));
    await expect(adapter().parseWebhookEvent(body, sign(body, "some_other_secret"))).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("an irrelevant event type is still ignored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await parse(adapter(), "customer.created", { id: "ctm_1" })).toBeNull();
    warn.mockRestore();
  });
});

describe("partner code on wallet payments (affiliate attribution)", () => {
  it("a pack carries customData.partnerCode onto the wallet_pack event", async () => {
    const ev: any = await parse(adapter(), "transaction.completed", transactionData({ priceId: FAKE_PRICES.starterPack, customData: { account_id: ACCOUNT_ID, sku: SKU.starterPack, partnerCode: "sarah" } }));
    expect(ev).toMatchObject({ kind: "wallet_pack", partnerCode: "sarah" });
  });

  it("a plan payment carries customData.partnerCode onto the wallet_plan payment event", async () => {
    const ev: any = await parse(adapter(), "transaction.completed", transactionData({ id: "txn_fake_2", priceId: FAKE_PRICES.growthPlan, subscriptionId: "sub_fake_1", billingPeriod: { starts_at: PERIOD_START, ends_at: PERIOD_END }, customData: { account_id: ACCOUNT_ID, partnerCode: "sarah" } }));
    expect(ev).toMatchObject({ kind: "wallet_plan", phase: "payment", partnerCode: "sarah" });
  });

  it("no code, or a non text code, leaves partnerCode undefined", async () => {
    const a: any = await parse(adapter(), "transaction.completed", transactionData({ priceId: FAKE_PRICES.starterPack }));
    const b: any = await parse(adapter(), "transaction.completed", transactionData({ priceId: FAKE_PRICES.starterPack, customData: { account_id: ACCOUNT_ID, partnerCode: 7 } }));
    expect(a.partnerCode).toBeUndefined();
    expect(b.partnerCode).toBeUndefined();
  });
});
