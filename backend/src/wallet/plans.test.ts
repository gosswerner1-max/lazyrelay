import { describe, expect, it } from "vitest";
import { ACCOUNT_LIMITS } from "../accountLimits.js";
import { BRAND_LIMITS } from "../brandLimits.js";
import { PLANS, PLAN_IDS } from "./plans.js";
import { CATALOG, SKU } from "./catalog.js";

describe("plans as data (nothing reads them yet)", () => {
  it("has exactly the four plans", () => expect(PLAN_IDS).toEqual(["free", "payg", "growth", "pro"]));

  it("free: 30 credits once at registration, no expiry, no monthly reset; 3 accounts, 1 brand, 10 queued posts", () => {
    expect(PLANS.free).toEqual({ id: "free", priceCents: 0, cadence: "none", credits: 30, creditsExpire: false, grantedOnce: true, maxAccounts: 3, maxBrands: 1, maxQueuedPosts: 10 });
  });

  it("payg: a 15 USD pack gives 300 credits that never expire; 20 accounts, 2 brands", () => {
    expect(PLANS.payg).toEqual({ id: "payg", priceCents: 1500, cadence: "one_time", credits: 300, creditsExpire: false, grantedOnce: false, maxAccounts: 20, maxBrands: 2, maxQueuedPosts: null });
  });

  it("growth: 29 USD a month gives 1,000 credits that expire at period end; 30 accounts, 4 brands", () => {
    expect(PLANS.growth).toEqual({ id: "growth", priceCents: 2900, cadence: "month", credits: 1000, creditsExpire: true, grantedOnce: false, maxAccounts: 30, maxBrands: 4, maxQueuedPosts: null });
  });

  it("pro: 99 USD a month gives 6,000 credits that expire at period end; 1,000 accounts, unlimited brands", () => {
    expect(PLANS.pro).toEqual({ id: "pro", priceCents: 9900, cadence: "month", credits: 6000, creditsExpire: true, grantedOnce: false, maxAccounts: 1000, maxBrands: null, maxQueuedPosts: null });
  });

  it("money is whole cents and credits are whole numbers", () => {
    for (const p of Object.values(PLANS)) {
      expect(Number.isInteger(p.priceCents)).toBe(true);
      expect(Number.isInteger(p.credits)).toBe(true);
    }
  });

  it("the payg and growth caps equal the live Starter and Pro limits, so enforcement can later reuse those tables", () => {
    expect(PLANS.payg.maxAccounts).toBe(ACCOUNT_LIMITS.starter);
    expect(PLANS.payg.maxBrands).toBe(BRAND_LIMITS.starter);
    expect(PLANS.growth.maxAccounts).toBe(ACCOUNT_LIMITS.pro);
    expect(PLANS.growth.maxBrands).toBe(BRAND_LIMITS.pro);
    expect(PLANS.free.maxAccounts).toBe(ACCOUNT_LIMITS.free);
    expect(PLANS.free.maxBrands).toBe(BRAND_LIMITS.free);
  });

  it("plans.ts and catalog.ts agree: Growth 1,000 credits and 30 accounts / 4 brands, Pro 6,000 and 1,000 / unlimited, the payg pack 300", () => {
    expect(CATALOG[SKU.growthPlan]).toMatchObject({ credits: PLANS.growth.credits, priceCents: PLANS.growth.priceCents });
    expect(CATALOG[SKU.proPlan]).toMatchObject({ credits: PLANS.pro.credits, priceCents: PLANS.pro.priceCents });
    expect(CATALOG[SKU.starterPack]).toMatchObject({ credits: PLANS.payg.credits, priceCents: PLANS.payg.priceCents });
    expect([PLANS.growth.credits, PLANS.growth.maxAccounts, PLANS.growth.maxBrands]).toEqual([1000, 30, 4]);
    expect([PLANS.pro.credits, PLANS.pro.maxAccounts, PLANS.pro.maxBrands]).toEqual([6000, 1000, null]);
    expect(PLANS.payg.credits).toBe(300);
    expect(CATALOG[SKU.growthPlan].description).toContain("30 connected social accounts");
    expect(CATALOG[SKU.growthPlan].description).toContain("4 distinct brand profiles");
    expect(CATALOG[SKU.proPlan].description).toContain("1,000 connected accounts");
    expect(CATALOG[SKU.proPlan].description).toContain("unlimited brand profiles");
  });
});
