import { describe, it, expect } from "vitest";
import { buildCheckoutIntent, buildCatalogView, type PackRow } from "./checkout.js";
import { SKU, CATALOG } from "./catalog.js";

describe("buildCheckoutIntent", () => {
  it("rejects an unknown sku", () => {
    expect(buildCheckoutIntent("nope", "free")).toEqual({ ok: false, status: 400, error: "unknown_sku" });
    expect(buildCheckoutIntent(undefined, "free")).toEqual({ ok: false, status: 400, error: "unknown_sku" });
  });

  it("gives a pack to anyone, as plus tax data with no tax math", () => {
    const r = buildCheckoutIntent(SKU.starterPack, "free");
    expect(r).toEqual({
      ok: true,
      intent: { sku: SKU.starterPack, name: "LazyCredits Starter Pack", kind: "pack", credits: 300, priceCents: 1500, currency: "USD", taxNote: "plus tax", expires: false },
    });
  });

  it("blocks the Pro top-up for every tier that is not the new Pro plan", () => {
    for (const tier of ["free", "payg", "growth", "starter", "pro", "business", "agency", "agency_plus"] as const) {
      expect(buildCheckoutIntent(SKU.proTopUp, tier), tier).toEqual({ ok: false, status: 403, error: "plan_required", requiredPlan: "pro" });
    }
  });

  it("allows the Pro top-up on the Pro plan (tier lazy_pro)", () => {
    const r = buildCheckoutIntent(SKU.proTopUp, "lazy_pro");
    expect(r.ok).toBe(true);
  });

  it("refuses an inactive sku", () => {
    const entry = CATALOG[SKU.growthPack];
    entry.active = false;
    try {
      expect(buildCheckoutIntent(SKU.growthPack, "free")).toEqual({ ok: false, status: 400, error: "unknown_sku" });
    } finally {
      entry.active = true;
    }
  });
});

describe("buildCatalogView", () => {
  const rows: PackRow[] = [
    { sku: SKU.starterPack, name: "LazyCredits Starter Pack", kind: "pack", price_cents: 1500, credits: 300, expires: false, interval: "one_time", requires_plan: null, active: true },
    { sku: SKU.proTopUp, name: "LazyCredits Pro Top-Up", kind: "pack", price_cents: 3000, credits: 1500, expires: false, interval: "one_time", requires_plan: "pro", active: true },
    { sku: SKU.proPlan, name: "LazyRelay Pro Plan", kind: "subscription", price_cents: 9900, credits: 6000, expires: true, interval: "month", requires_plan: null, active: true },
    { sku: SKU.growthPlan, name: "LazyRelay Growth Plan", kind: "subscription", price_cents: 2900, credits: 1000, expires: true, interval: "month", requires_plan: null, active: false },
  ];

  it("lists active rows with the copy from catalog.ts and every amount as plus tax data", () => {
    const view = buildCatalogView(rows);
    expect(view.map((v) => v.sku)).toEqual([SKU.starterPack, SKU.proTopUp, SKU.proPlan]);
    expect(view[0]).toMatchObject({ sku: SKU.starterPack, priceCents: 1500, currency: "USD", taxNote: "plus tax", credits: 300, description: CATALOG[SKU.starterPack].description });
    expect(view[1]).toMatchObject({ requiresPlan: "pro" });
    expect(view[2]).toMatchObject({ kind: "subscription", interval: "month", expires: true });
  });

  it("drops rows the code does not know, so nothing unsellable is shown", () => {
    const view = buildCatalogView([...rows, { ...rows[0], sku: "mystery-pack" }]);
    expect(view.some((v) => v.sku === "mystery-pack")).toBe(false);
  });

  it("uses no em or en dashes in any text it returns", () => {
    expect(JSON.stringify(buildCatalogView(rows))).not.toMatch(/[–—]/);
  });
});
