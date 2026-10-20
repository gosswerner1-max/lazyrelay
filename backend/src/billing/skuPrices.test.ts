import { describe, it, expect } from "vitest";
import { SKU } from "../wallet/catalog.js";
import { SKU_PRICE_ENV_VARS, priceIdForSku, skuForPriceId, skuForPriceIds, walletPlanForSku } from "./skuPrices.js";
import { WALLET_ENV, FAKE_PRICES } from "./walletFixtures.testHelper.js";

describe("sku price map", () => {
  it("names one env var per catalog sku", () => {
    expect(SKU_PRICE_ENV_VARS).toEqual({
      [SKU.starterPack]: "PADDLE_PRICE_ID_LC_STARTER_PACK",
      [SKU.growthPack]: "PADDLE_PRICE_ID_LC_GROWTH_PACK",
      [SKU.proTopUp]: "PADDLE_PRICE_ID_LC_PRO_TOPUP",
      [SKU.growthPlan]: "PADDLE_PRICE_ID_GROWTH_PLAN",
      [SKU.proPlan]: "PADDLE_PRICE_ID_PRO_PLAN",
    });
  });

  it("maps a price id to its sku and back", () => {
    expect(skuForPriceId(FAKE_PRICES.starterPack, WALLET_ENV)).toBe(SKU.starterPack);
    expect(skuForPriceId(FAKE_PRICES.proPlan, WALLET_ENV)).toBe(SKU.proPlan);
    expect(priceIdForSku(SKU.growthPlan, WALLET_ENV)).toBe(FAKE_PRICES.growthPlan);
  });

  it("returns null for an unknown price id, so the old six tier path handles it", () => {
    expect(skuForPriceId("pri_somebody_else", WALLET_ENV)).toBeNull();
    expect(skuForPriceId("", WALLET_ENV)).toBeNull();
    expect(skuForPriceIds(["pri_a", "pri_b"], WALLET_ENV)).toBeNull();
  });

  it("returns null for every price when the env vars are not set", () => {
    expect(skuForPriceId(FAKE_PRICES.starterPack, {})).toBeNull();
    expect(priceIdForSku(SKU.starterPack, {})).toBeUndefined();
  });

  it("finds the sku among several line items and refuses two different skus on one payload", () => {
    expect(skuForPriceIds(["pri_other", FAKE_PRICES.growthPack], WALLET_ENV)).toBe(SKU.growthPack);
    expect(() => skuForPriceIds([FAKE_PRICES.growthPack, FAKE_PRICES.proPlan], WALLET_ENV)).toThrow(/more than one/);
  });

  it("names the wallet plan a subscription sku grants, and none for a pack", () => {
    expect(walletPlanForSku(SKU.growthPlan)).toBe("growth");
    expect(walletPlanForSku(SKU.proPlan)).toBe("pro");
    expect(walletPlanForSku(SKU.starterPack)).toBeNull();
  });
});
