import { describe, it, expect, vi, beforeEach } from "vitest";

// Same reasoning as seatAddon.test.ts (TimeAJob's own, ported here since
// this is the same account/SDK): this Paddle account is real, production,
// no sandbox configured -- a unit test must never construct a real Paddle
// client and actually invoke .transactions.create() or .discounts.list().
// vi.hoisted shares the spies between the mock factory (hoisted above the
// imports below) and the assertions further down.
const { mockDiscountsList, mockTransactionsCreate, mockCustomersList, mockCustomersCreate } = vi.hoisted(() => ({
  mockDiscountsList: vi.fn(),
  mockTransactionsCreate: vi.fn(),
  mockCustomersList: vi.fn(),
  mockCustomersCreate: vi.fn(),
}));

vi.mock("@paddle/paddle-node-sdk", () => {
  class Paddle {
    discounts = { list: mockDiscountsList };
    transactions = { create: mockTransactionsCreate };
    customers = { list: mockCustomersList, create: mockCustomersCreate };
    subscriptions = { update: vi.fn(), cancel: vi.fn() };
    webhooks = { isSignatureValid: vi.fn(), unmarshal: vi.fn() };
    constructor(_apiKey: string, _opts: unknown) {}
  }
  return { Paddle, Environment: { production: "production", sandbox: "sandbox" } };
});

import { Environment } from "@paddle/paddle-node-sdk";
import { buildCheckoutTransaction } from "./paddle.js";

const BASE_PARAMS = {
  kind: "tier" as const,
  accountEmail: "test@example.com",
  accountId: "acct_test",
  tier: "pro" as const,
  priceId: "pri_test_starter",
};

describe("buildCheckoutTransaction -- launch-discount promo code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCustomersList.mockReturnValue({ next: vi.fn().mockResolvedValue([{ id: "ctm_existing" }]) });
    mockTransactionsCreate.mockResolvedValue({ id: "txn_123", checkout: { url: "https://lazyrelay.com" } });
  });

  it("passes no discountId when no promo code was given", async () => {
    await buildCheckoutTransaction("key", Environment.production, BASE_PARAMS);
    expect(mockDiscountsList).not.toHaveBeenCalled();
    expect(mockTransactionsCreate).toHaveBeenCalledWith(expect.not.objectContaining({ discountId: expect.anything() }));
  });

  it("resolves a valid code to its real Paddle discount id and attaches it to the transaction", async () => {
    mockDiscountsList.mockReturnValue({ next: vi.fn().mockResolvedValue([{ id: "dsc_real123" }]) });
    await buildCheckoutTransaction("key", Environment.production, { ...BASE_PARAMS, discountCode: "LAUNCH20" });
    expect(mockDiscountsList).toHaveBeenCalledWith({ code: ["LAUNCH20"] });
    expect(mockTransactionsCreate).toHaveBeenCalledWith(expect.objectContaining({ discountId: "dsc_real123" }));
  });

  it("fails open (checkout still proceeds, no discountId) when the code doesn't resolve to anything", async () => {
    mockDiscountsList.mockReturnValue({ next: vi.fn().mockResolvedValue([]) });
    const result = await buildCheckoutTransaction("key", Environment.production, { ...BASE_PARAMS, discountCode: "EXPIRED-OR-FAKE" });
    expect(result.transactionId).toBe("txn_123");
    expect(mockTransactionsCreate).toHaveBeenCalledWith(expect.not.objectContaining({ discountId: expect.anything() }));
  });

  it("fails open when the Paddle discounts lookup itself throws", async () => {
    mockDiscountsList.mockReturnValue({ next: vi.fn().mockRejectedValue(new Error("network blip")) });
    const result = await buildCheckoutTransaction("key", Environment.production, { ...BASE_PARAMS, discountCode: "LAUNCH20" });
    expect(result.transactionId).toBe("txn_123");
    expect(mockTransactionsCreate).toHaveBeenCalledWith(expect.not.objectContaining({ discountId: expect.anything() }));
  });
});
