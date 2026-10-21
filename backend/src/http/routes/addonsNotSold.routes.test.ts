// The legacy storage, brand and seat add-on checkouts are no longer sold: every request gets 410 before any Paddle call,
// billing lock or database access. The cancel routes for existing add-ons keep working (they still reach the cancel code).

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const ctx = vi.hoisted(() => ({
  tier: "growth" as string,
  dbTouched: 0,
  paddleCalls: 0,
  lockCalls: 0,
  cancelCalls: [] as string[],
}));

vi.mock("../auth.js", () => {
  const pass = (req: any, _res: any, next: any) => {
    req.accountId = "acc1";
    req.db = { from: () => { ctx.dbTouched++; throw new Error("db used"); } };
    next();
  };
  return { requireAuth: pass, requireHumanAuth: (_r: any, _s: any, n: any) => n(), requireOwner: (_r: any, _s: any, n: any) => n() };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", () => ({ supabase: { from: () => { ctx.dbTouched++; throw new Error("db used"); } } }));
vi.mock("../../tier.js", () => ({ resolveTier: async () => ctx.tier }));
vi.mock("../../billing/paddle.js", () => ({ buildCheckoutTransaction: async () => { ctx.paddleCalls++; return { transactionId: "t", checkoutUrl: null }; } }));
vi.mock("../../billing/locks.js", () => ({ acquireBillingLock: async () => { ctx.lockCalls++; return true; }, releaseBillingLock: async () => {} }));
vi.mock("../../billing/sync.js", () => ({
  cancelSubscription: async () => ({ success: true }),
  cancelStorageAddon: async () => { ctx.cancelCalls.push("storage"); return { success: true }; },
  cancelBrandAddon: async () => { ctx.cancelCalls.push("brand"); return { success: true }; },
  cancelSeatAddon: async () => { ctx.cancelCalls.push("seat"); return { success: true }; },
}));
vi.mock("../../wallet/closeOldCheckout.js", () => ({ OLD_CHECKOUT_CLOSED_MESSAGE: "closed", oldTierCheckoutClosed: async () => false }));

const { buildBillingRouter } = await import("./billing.routes.js");

const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildBillingRouter({} as any));
  return a;
};
const EXPECTED = { error: "addon_not_sold", message: "This add-on is no longer sold. Plans and credits are on the pricing page." };

beforeEach(() => {
  process.env.MOR_API_KEY = "test";
  process.env.PADDLE_PRICE_ID_BRAND_ADDON = "pri_test";
  process.env.PADDLE_PRICE_ID_SEAT_ADDON = "pri_test";
  process.env.PADDLE_PRICE_ID_STORAGE_5GB = "pri_test";
  ctx.tier = "growth";
  ctx.dbTouched = 0;
  ctx.paddleCalls = 0;
  ctx.lockCalls = 0;
  ctx.cancelCalls = [];
});

describe("legacy add-on checkouts are closed", () => {
  const cases: Array<[string, string, object]> = [
    ["storage", "/storage-addons/checkout", { gbAmount: 5 }],
    ["storage (bad body)", "/storage-addons/checkout", {}],
    ["brand", "/brand-addons/checkout", {}],
    ["seat", "/seat-addons/checkout", {}],
  ];
  for (const tier of ["free", "growth", "lazy_pro", "business", "agency"]) {
    for (const [name, path, body] of cases) {
      it(`${name} on ${tier}: 410 addon_not_sold, no Paddle, no lock, no database`, async () => {
        ctx.tier = tier;
        const res = await request(app()).post(path).send(body);
        expect(res.status).toBe(410);
        expect(res.body).toEqual(EXPECTED);
        expect(ctx.paddleCalls).toBe(0);
        expect(ctx.lockCalls).toBe(0);
        expect(ctx.dbTouched).toBe(0);
      });
    }
  }

  it("the response text has no em or en dash", () => {
    expect(JSON.stringify(EXPECTED)).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`));
  });
});

describe("cancel routes for existing add-ons still work", () => {
  for (const kind of ["storage", "brand", "seat"]) {
    it(`${kind}: cancel reaches the cancel code`, async () => {
      const res = await request(app()).post(`/${kind}-addons/abc/cancel`).send({});
      expect(res.status).toBe(200);
      expect(ctx.cancelCalls).toEqual([kind]);
    });
  }
});
