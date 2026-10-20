import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOG, SKU, SKU_LIST, centsPerCredit } from "./catalog.js";

describe("the pack catalog (local staging data; nothing reads it yet)", () => {
  it("has exactly the five SKUs", () => {
    expect(SKU_LIST.map((s) => s.sku)).toEqual(["lazycredits-starter-pack", "lazycredits-growth-pack", "lazycredits-pro-top-up", "lazyrelay-growth-plan", "lazyrelay-pro-plan"]);
  });

  it("the Starter Pack: 15 USD, 300 credits, never expire", () => {
    expect(CATALOG[SKU.starterPack]).toEqual({
      sku: "lazycredits-starter-pack", name: "LazyCredits Starter Pack", kind: "pack", priceCents: 1500, credits: 300, expires: false, interval: "one_time", requiresPlan: null, paddlePriceId: null, active: true,
      description: "300 universal credits for multi-channel post distribution and deep competitor market analysis teardowns. Credits never expire.",
    });
  });

  it("the Growth Pack: 50 USD, 1,500 credits, never expire", () => {
    expect(CATALOG[SKU.growthPack]).toEqual({
      sku: "lazycredits-growth-pack", name: "LazyCredits Growth Pack", kind: "pack", priceCents: 5000, credits: 1500, expires: false, interval: "one_time", requiresPlan: null, paddlePriceId: null, active: true,
      description: "1,500 universal credits optimized for scaling brands running high-frequency distribution cadences. Credits never expire.",
    });
  });

  it("the Pro Top-Up: 30 USD, 1,500 credits, only for an active Pro plan", () => {
    expect(CATALOG[SKU.proTopUp]).toEqual({
      sku: "lazycredits-pro-top-up", name: "LazyCredits Pro Top-Up", kind: "pack", priceCents: 3000, credits: 1500, expires: false, interval: "one_time", requiresPlan: "pro", paddlePriceId: null, active: true,
      description: "1,500 universal credits available exclusively for active Pro Tier subscribers. Bound to active subscription status: credits expire if the subscription is canceled.",
    });
    expect(CATALOG[SKU.proTopUp].description).not.toMatch(/never expire/i);
  });

  it("the Growth Plan: 29 USD a month, 1,000 credits, expire at period end", () => {
    expect(CATALOG[SKU.growthPlan]).toEqual({
      sku: "lazyrelay-growth-plan", name: "LazyRelay Growth Plan", kind: "subscription", priceCents: 2900, credits: 1000, expires: true, interval: "month", requiresPlan: null, paddlePriceId: null, active: true,
      description: "Includes 1,000 universal monthly credits, 30 connected social accounts, and 4 distinct brand profiles.",
    });
  });

  it("the Pro Plan: 99 USD a month, 6,000 credits, expire at period end", () => {
    expect(CATALOG[SKU.proPlan]).toEqual({
      sku: "lazyrelay-pro-plan", name: "LazyRelay Pro Plan", kind: "subscription", priceCents: 9900, credits: 6000, expires: true, interval: "month", requiresPlan: null, paddlePriceId: null, active: true,
      description: "Includes 6,000 universal monthly credits, unlimited brand profiles, and high-volume agency scheduling limits up to 1,000 connected accounts.",
    });
  });

  it("price per credit, in cents, as data", () => {
    expect(centsPerCredit(SKU.starterPack)).toBe(5);
    expect(centsPerCredit(SKU.growthPack)).toBe(3.3333);
    expect(centsPerCredit(SKU.proTopUp)).toBe(2);
    expect(centsPerCredit(SKU.growthPlan)).toBe(2.9);
    expect(centsPerCredit(SKU.proPlan)).toBe(1.65);
  });

  it("no description holds an em or en dash", () => {
    for (const s of SKU_LIST) expect(s.description + s.name).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });

  it("the migration seeds the same rows (drift guard)", () => {
    const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations/0140_wallet_credit_lots.sql"), "utf8");
    for (const s of SKU_LIST) {
      const requires = s.requiresPlan === null ? "null" : `'${s.requiresPlan}'`;
      expect(sql).toContain(`('${s.sku}', '${s.name}', '${s.kind}', ${s.priceCents}, ${s.credits}, ${s.expires}, '${s.interval}', ${requires},`);
    }
  });
});
