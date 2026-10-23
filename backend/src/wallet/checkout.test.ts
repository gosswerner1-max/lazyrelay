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

const FREE = { tier: "free" as const, legacy: false, cancelPending: false };

describe("buildCatalogView", () => {
  const rows: PackRow[] = [
    { sku: SKU.starterPack, name: "LazyCredits Starter Pack", kind: "pack", price_cents: 1500, credits: 300, expires: false, interval: "one_time", requires_plan: null, active: true },
    { sku: SKU.proTopUp, name: "LazyCredits Pro Top-Up", kind: "pack", price_cents: 3000, credits: 1500, expires: false, interval: "one_time", requires_plan: "pro", active: true },
    { sku: SKU.proPlan, name: "LazyRelay Pro Plan", kind: "subscription", price_cents: 9900, credits: 6000, expires: true, interval: "month", requires_plan: null, active: true },
    { sku: SKU.growthPlan, name: "LazyRelay Growth Plan", kind: "subscription", price_cents: 2900, credits: 1000, expires: true, interval: "month", requires_plan: null, active: false },
  ];

  it("lists active rows with the copy from catalog.ts and every amount as plus tax data", () => {
    const view = buildCatalogView(rows, FREE);
    expect(view.map((v) => v.sku)).toEqual([SKU.starterPack, SKU.proTopUp, SKU.proPlan]);
    expect(view[0]).toMatchObject({ sku: SKU.starterPack, priceCents: 1500, currency: "USD", taxNote: "plus tax", credits: 300, description: CATALOG[SKU.starterPack].description });
    expect(view[1]).toMatchObject({ requiresPlan: "pro" });
    expect(view[2]).toMatchObject({ kind: "subscription", interval: "month", expires: true });
  });

  it("drops rows the code does not know, so nothing unsellable is shown", () => {
    const view = buildCatalogView([...rows, { ...rows[0], sku: "mystery-pack" }], FREE);
    expect(view.some((v) => v.sku === "mystery-pack")).toBe(false);
  });

  it("uses no em or en dashes in any text it returns", () => {
    expect(JSON.stringify(buildCatalogView(rows, FREE))).not.toMatch(/[–—]/);
  });

  const allRows: PackRow[] = [
    ...rows.slice(0, 3),
    { sku: SKU.growthPlan, name: "LazyRelay Growth Plan", kind: "subscription", price_cents: 2900, credits: 1000, expires: true, interval: "month", requires_plan: null, active: true },
    { sku: SKU.growthPack, name: "LazyCredits Growth Pack", kind: "pack", price_cents: 5000, credits: 1500, expires: false, interval: "one_time", requires_plan: null, active: true },
  ];
  const verdicts = (ctx: Parameters<typeof buildCatalogView>[1]) => Object.fromEntries(buildCatalogView(allRows, ctx).map((i) => [i.sku, [i.purchasable, i.reason]]));

  it("free account: packs and plans buyable, Pro top-up needs Pro", () => {
    expect(verdicts(FREE)).toEqual({
      [SKU.starterPack]: [true, null], [SKU.growthPack]: [true, null], [SKU.growthPlan]: [true, null], [SKU.proPlan]: [true, null],
      [SKU.proTopUp]: [false, "needs_pro"],
    });
  });

  it("legacy account: nothing is purchasable, reason legacy_account", () => {
    for (const v of Object.values(verdicts({ tier: "lazy_pro", legacy: true, cancelPending: false }))) expect(v).toEqual([false, "legacy_account"]);
  });

  it("growth plan: the Growth plan is already_subscribed, the rest as free", () => {
    const v = verdicts({ tier: "growth", legacy: false, cancelPending: false });
    expect(v[SKU.growthPlan]).toEqual([false, "already_subscribed"]);
    expect(v[SKU.proPlan]).toEqual([true, null]);
    expect(v[SKU.proTopUp]).toEqual([false, "needs_pro"]);
  });

  it("pro plan: Pro plan already_subscribed, top-up buyable", () => {
    const v = verdicts({ tier: "lazy_pro", legacy: false, cancelPending: false });
    expect(v[SKU.proPlan]).toEqual([false, "already_subscribed"]);
    expect(v[SKU.proTopUp]).toEqual([true, null]);
    expect(v[SKU.starterPack]).toEqual([true, null]);
  });

  it("pro plan with a pending cancel: top-up is plan_ending", () => {
    expect(verdicts({ tier: "lazy_pro", legacy: false, cancelPending: true })[SKU.proTopUp]).toEqual([false, "plan_ending"]);
  });

  it("old paid tiers have no wallet plan: top-up needs_pro", () => {
    expect(verdicts({ tier: "business", legacy: false, cancelPending: false })[SKU.proTopUp]).toEqual([false, "needs_pro"]);
  });

  it("marks plan-bound items expires true in the view only", () => {
    const items = buildCatalogView(allRows, FREE);
    expect(items.find((i) => i.sku === SKU.proTopUp)?.expires).toBe(true);
    expect(CATALOG[SKU.proTopUp].expires).toBe(false);
    expect(items.find((i) => i.sku === SKU.starterPack)?.expires).toBe(false);
  });
});

describe("buildCatalogView with the live Growth Pack gate (wallet_packs.requires_plan = 'growth')", () => {
  const livePack: PackRow = { sku: SKU.growthPack, name: "LazyCredits Growth Pack", kind: "pack", price_cents: 5000, credits: 1500, expires: false, interval: "one_time", requires_plan: "growth", active: true };
  const topUp: PackRow = { sku: SKU.proTopUp, name: "LazyCredits Pro Top-Up", kind: "pack", price_cents: 3000, credits: 1500, expires: false, interval: "one_time", requires_plan: "pro", active: true };
  const verdict = (tier: Parameters<typeof buildCatalogView>[1]["tier"], cancelPending = false) =>
    Object.fromEntries(buildCatalogView([livePack, topUp], { tier, legacy: false, cancelPending }).map((i) => [i.sku, [i.purchasable, i.reason]]));

  it("names the Growth plan, not Pro, as the missing plan for the Growth Pack", () => {
    for (const tier of ["free", "lazy_pro", "business"] as const) expect(verdict(tier)[SKU.growthPack], tier).toEqual([false, "needs_growth"]);
  });

  it("keeps needs_pro for the Pro Top-Up", () => {
    expect(verdict("free")[SKU.proTopUp]).toEqual([false, "needs_pro"]);
    expect(verdict("growth")[SKU.proTopUp]).toEqual([false, "needs_pro"]);
  });

  it("the Growth plan can buy the Growth Pack, and a pending cancel makes it plan_ending", () => {
    expect(verdict("growth")[SKU.growthPack]).toEqual([true, null]);
    expect(verdict("growth", true)[SKU.growthPack]).toEqual([false, "plan_ending"]);
  });
});
