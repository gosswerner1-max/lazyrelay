// The /api/wallet routes: invisible while the wallet switch is off, account scoped, and the teardown never hands a token to the browser.
// Login, the rate limiter and the tier lookup are mocked; the ledger, the engine and Paddle are stubs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

const auth = vi.hoisted(() => ({ mode: "jwt" as "none" | "jwt" | "apiKey", userId: "user-1", accountId: "acc-1", role: "owner" as "owner" | "member" }));
vi.mock("../auth.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../auth.js")>();
  return {
    ...real,
    requireAuth: (req: any, res: any, next: any) => {
      if (auth.mode === "none") {
        res.status(401).json({ error: "Missing or invalid credentials" });
        return;
      }
      req.authMethod = auth.mode;
      req.accountId = auth.accountId;
      if (auth.mode === "jwt") {
        req.userId = auth.userId;
        req.role = auth.role;
      }
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({
  tieredRateLimit: (_req: any, _res: any, next: any) => next(),
  publicRateLimit: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../securityAlerts.js", () => ({ recordSecurityEvent: () => {} }));

const { buildWalletRouter } = await import("./wallet.routes.js");
const { SKU } = await import("../../wallet/catalog.js");

const balanceView = { spendableMicro: 30_000_000, heldMicro: 0, byKindMicro: { signup: 30_000_000, pack: 0, subscription: 0 }, displayCredits: "30", heldCredits: "0", nextExpiryAt: null, nextExpiryCredits: null, nextExpiryMicro: null, activeHolds: 0, lots: [] };

function stubs() {
  return {
    service: { getBalance: vi.fn(async (_id: string) => balanceView) },
    runTeardown: vi.fn(async (_i: any) => ({ status: 200, body: { analysis: {}, blueprint: {}, charged: true } })),
    getTier: vi.fn(async (_id: string) => "free" as any),
    isLegacy: vi.fn(async (_id: string) => false),
    isCancelPending: vi.fn(async (_id: string) => false),
    readPacks: vi.fn(async () => [
      { sku: SKU.starterPack, name: "LazyCredits Starter Pack", kind: "pack", price_cents: 1500, credits: 300, expires: false, interval: "one_time", requires_plan: null, active: true },
    ]),
    checkout: { createCheckout: vi.fn(async (accountId: string, sku: string, _opts?: { partnerCode?: string }) => ({ checkoutId: `txn_${accountId}_${sku}` })) },
    resolvePartnerCode: vi.fn(async (code: unknown, _accountId?: string) => (code === "sarah" ? "Sarah" : null)),
    discountConfigured: () => true,
  };
}
type Stubs = ReturnType<typeof stubs>;
const mount = (s: Stubs, withRouter = true) => {
  const a = express();
  a.use(express.json());
  if (withRouter) a.use("/wallet", buildWalletRouter(s as never));
  return a;
};

let s: Stubs;
const saved = process.env.WALLET_ENABLED;
beforeEach(() => {
  auth.mode = "jwt";
  auth.userId = "user-1";
  auth.accountId = "acc-1";
  auth.role = "owner";
  s = stubs();
  process.env.WALLET_ENABLED = "true";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.WALLET_ENABLED;
  else process.env.WALLET_ENABLED = saved;
});

describe("wallet switch off: the routes do not exist", () => {
  it("answers exactly like an unknown route for every method, path and caller", async () => {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.WALLET_ENABLED;
      else process.env.WALLET_ENABLED = value;
      for (const mode of ["none", "jwt", "apiKey"] as const) {
        auth.mode = mode;
        for (const [method, path] of [["get", "/wallet/balance"], ["get", "/wallet/catalog"], ["post", "/wallet/checkout-intent"], ["post", "/wallet/teardown"]] as const) {
          const res = await (request(mount(s)) as any)[method](path).set("Idempotency-Key", "k1").send({ sku: SKU.starterPack, input: "https://x.example" });
          const unknown = await (request(mount(s, false)) as any)[method](path).set("Idempotency-Key", "k1").send({});
          expect(res.status, `${value} ${mode} ${method} ${path}`).toBe(404);
          expect(res.text).toBe(unknown.text);
        }
      }
    }
    expect(s.service.getBalance).not.toHaveBeenCalled();
    expect(s.runTeardown).not.toHaveBeenCalled();
    expect(s.checkout.createCheckout).not.toHaveBeenCalled();
    expect(s.getTier).not.toHaveBeenCalled();
  });
});

describe("GET /wallet/balance", () => {
  it("needs a login", async () => {
    auth.mode = "none";
    expect((await request(mount(s)).get("/wallet/balance")).status).toBe(401);
  });

  it("reads the balance of the signed in account only", async () => {
    const res = await request(mount(s)).get("/wallet/balance?accountId=someone-else");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(balanceView); // the service's own view is still sent, with the website's fields added (see wallet.contract.test.ts)
    expect(res.body).toMatchObject({ exempt: false, balance: 30, held: 0, plan: { tier: "free", walletPlan: "free" } });
    expect(s.service.getBalance).toHaveBeenCalledWith("acc-1");
  });

  it("surfaces a wallet failure as a 503 and logs it", async () => {
    s.service.getBalance.mockRejectedValueOnce(new Error("wallet down"));
    const res = await request(mount(s)).get("/wallet/balance");
    expect(res.status).toBe(503);
    expect(console.error).toHaveBeenCalled();
  });
});

describe("GET /wallet/catalog", () => {
  it("returns the active rows as plus tax data", async () => {
    const res = await request(mount(s)).get("/wallet/catalog");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ sku: SKU.starterPack, priceCents: 1500, taxNote: "plus tax", credits: 300 });
  });

  const allRows = () => [
    { sku: SKU.starterPack, name: "LazyCredits Starter Pack", kind: "pack", price_cents: 1500, credits: 300, expires: false, interval: "one_time", requires_plan: null, active: true },
    { sku: SKU.proTopUp, name: "LazyCredits Pro Top-Up", kind: "pack", price_cents: 3000, credits: 1500, expires: false, interval: "one_time", requires_plan: "pro", active: true },
    { sku: SKU.growthPlan, name: "LazyRelay Growth Plan", kind: "subscription", price_cents: 2900, credits: 1000, expires: true, interval: "month", requires_plan: null, active: true },
    { sku: SKU.proPlan, name: "LazyRelay Pro Plan", kind: "subscription", price_cents: 9900, credits: 6000, expires: true, interval: "month", requires_plan: null, active: true },
  ];
  const bySku = (items: any[]) => Object.fromEntries(items.map((i) => [i.sku, [i.purchasable, i.reason]]));

  it("carries purchasable and reason on every item for a free account", async () => {
    s.readPacks.mockImplementation(async () => allRows());
    const res = await request(mount(s)).get("/wallet/catalog");
    expect(bySku(res.body.items)).toEqual({
      [SKU.starterPack]: [true, null], [SKU.proTopUp]: [false, "needs_pro"], [SKU.growthPlan]: [true, null], [SKU.proPlan]: [true, null],
    });
    expect(s.isLegacy).toHaveBeenCalledWith("acc-1");
  });

  it("legacy account: nothing purchasable", async () => {
    s.readPacks.mockImplementation(async () => allRows());
    s.isLegacy.mockImplementation(async () => true);
    const res = await request(mount(s)).get("/wallet/catalog");
    for (const v of Object.values(bySku(res.body.items))) expect(v).toEqual([false, "legacy_account"]);
  });

  it("pro account with a cancel pending: top-up plan_ending, plan already_subscribed", async () => {
    s.readPacks.mockImplementation(async () => allRows());
    s.getTier.mockImplementation(async () => "lazy_pro");
    s.isCancelPending.mockImplementation(async () => true);
    const res = await request(mount(s)).get("/wallet/catalog");
    const v = bySku(res.body.items);
    expect(v[SKU.proTopUp]).toEqual([false, "plan_ending"]);
    expect(v[SKU.proPlan]).toEqual([false, "already_subscribed"]);
    expect(res.body.items.find((i: any) => i.sku === SKU.proTopUp).expires).toBe(true);
  });

  it("the live Growth Pack row (requires_plan growth) says needs_growth on a free account and the Pro Top-Up still says needs_pro", async () => {
    s.readPacks.mockImplementation(async () => [
      ...allRows(),
      { sku: SKU.growthPack, name: "LazyCredits Growth Pack", kind: "pack", price_cents: 5000, credits: 1500, expires: false, interval: "one_time", requires_plan: "growth", active: true },
    ]);
    const res = await request(mount(s)).get("/wallet/catalog");
    const v = bySku(res.body.items);
    expect(v[SKU.growthPack]).toEqual([false, "needs_growth"]);
    expect(v[SKU.proTopUp]).toEqual([false, "needs_pro"]);
    expect(res.body.items.find((i: any) => i.sku === SKU.growthPack)).toMatchObject({ priceCents: 5000, credits: 1500, requiresPlan: "growth" });
  });

  it("answers 503 when the legacy check throws", async () => {
    s.isLegacy.mockImplementation(async () => { throw new Error("db down"); });
    expect((await request(mount(s)).get("/wallet/catalog")).status).toBe(503);
  });

  // CONTRACT: a copy of the validation rules in frontend/src/lib/walletApi.ts readItem. If the frontend changes them, change this copy too.
  const REASONS = ["needs_pro", "needs_growth", "already_subscribed", "legacy_account", "plan_ending"];
  const isCount = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
  const frontendAccepts = (v: any): boolean =>
    v !== null && typeof v === "object" && typeof v.sku === "string" && v.sku !== "" && typeof v.name === "string" &&
    ["pack", "subscription"].includes(v.kind) && isCount(v.priceCents) && isCount(v.credits) &&
    typeof v.expires === "boolean" && ["one_time", "month"].includes(v.interval) && typeof v.purchasable === "boolean" &&
    (v.requiresPlan === null || typeof v.requiresPlan === "string") && (v.reason === null || REASONS.includes(v.reason));

  it("CONTRACT: every item the route returns passes the frontend validation and has the 11 keys", async () => {
    const keys = ["sku", "name", "kind", "priceCents", "credits", "expires", "interval", "requiresPlan", "purchasable", "reason"];
    s.readPacks.mockImplementation(async () => allRows());
    for (const [tier, legacy, cancel] of [["free", false, false], ["growth", false, false], ["lazy_pro", false, true], ["lazy_pro", true, false], ["business", false, false]] as const) {
      s.getTier.mockImplementation(async () => tier as any);
      s.isLegacy.mockImplementation(async () => legacy);
      s.isCancelPending.mockImplementation(async () => cancel);
      const res = await request(mount(s)).get("/wallet/catalog");
      expect(res.body.items).toHaveLength(4);
      for (const item of res.body.items) {
        for (const k of keys) expect(item, `${tier} ${item.sku} missing ${k}`).toHaveProperty(k);
        expect(frontendAccepts(item), `${tier} ${item.sku}`).toBe(true);
      }
    }
  });
});

describe("POST /wallet/checkout-intent", () => {
  const post = (body: unknown) => request(mount(s)).post("/wallet/checkout-intent").send(body as object);

  it("rejects an unknown sku and a missing body", async () => {
    expect((await post({ sku: "nope" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(s.checkout.createCheckout).not.toHaveBeenCalled();
  });

  it("blocks the Pro top-up for a non Pro account", async () => {
    const res = await post({ sku: SKU.proTopUp });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "plan_required", requiredPlan: "pro" });
    expect(s.checkout.createCheckout).not.toHaveBeenCalled();
  });

  it("allows the Pro top-up on the Pro plan and passes the signed in account (never a body value) to the checkout port", async () => {
    s.getTier.mockResolvedValueOnce("lazy_pro");
    const res = await post({ sku: SKU.proTopUp, accountId: "forged" });
    expect(res.status).toBe(200);
    expect(s.checkout.createCheckout).toHaveBeenCalledWith("acc-1", SKU.proTopUp);
    expect(res.body.intent).toMatchObject({ sku: SKU.proTopUp, taxNote: "plus tax" });
    expect(res.body.checkout).toEqual({ checkoutId: `txn_acc-1_${SKU.proTopUp}` });
  });

  it("returns the intent and the checkout for a pack", async () => {
    const res = await post({ sku: SKU.starterPack });
    expect(res.status).toBe(200);
    expect(res.body.intent).toMatchObject({ sku: SKU.starterPack, credits: 300, priceCents: 1500 });
  });

  it("answers 503 when no checkout port is wired, instead of pretending", async () => {
    const res = await request(mount({ ...s, checkout: null } as never)).post("/wallet/checkout-intent").send({ sku: SKU.starterPack });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("checkout_not_available");
  });

  it("refuses an API key and a non owner team member", async () => {
    auth.mode = "apiKey";
    expect((await post({ sku: SKU.starterPack })).status).toBe(403);
    auth.mode = "jwt";
    auth.role = "member";
    expect((await post({ sku: SKU.starterPack })).status).toBe(403);
    expect(s.checkout.createCheckout).not.toHaveBeenCalled();
  });
});

describe("POST /wallet/checkout-intent with a partner code (affiliate attribution)", () => {
  const post = (body: unknown) => request(mount(s)).post("/wallet/checkout-intent").send(body as object);

  it("passes the approved partner's real code to the checkout port", async () => {
    const res = await post({ sku: SKU.starterPack, partnerCode: "sarah" });
    expect(res.status).toBe(200);
    expect(s.resolvePartnerCode).toHaveBeenCalledWith("sarah", "acc-1");
    expect(s.checkout.createCheckout).toHaveBeenCalledWith("acc-1", SKU.starterPack, { partnerCode: "Sarah" });
  });

  it("an unknown code is dropped quietly: the checkout is created exactly as before", async () => {
    const res = await post({ sku: SKU.starterPack, partnerCode: "nobody" });
    expect(res.status).toBe(200);
    expect(s.checkout.createCheckout).toHaveBeenCalledWith("acc-1", SKU.starterPack);
  });

  it("a failing code lookup never fails the checkout", async () => {
    s.resolvePartnerCode.mockRejectedValueOnce(new Error("db down"));
    const res = await post({ sku: SKU.starterPack, partnerCode: "sarah" });
    expect(res.status).toBe(200);
    expect(s.checkout.createCheckout).toHaveBeenCalledWith("acc-1", SKU.starterPack);
  });

  it("no code in the body means no lookup at all", async () => {
    await post({ sku: SKU.starterPack });
    expect(s.resolvePartnerCode).not.toHaveBeenCalled();
  });
});

describe("the partner code at the payment window (typed code box)", () => {
  const post = (body: unknown) => request(mount(s)).post("/wallet/checkout-intent").send(body as object);
  const check = (body: unknown) => request(mount(s)).post("/wallet/partner-code/check").send(body as object);

  it("checkout-intent says applied, with the discount flag the checkout port reported", async () => {
    s.checkout.createCheckout.mockResolvedValueOnce({ checkoutUrl: "u", transactionId: "t", discountApplied: true } as never);
    const res = await post({ sku: SKU.starterPack, partnerCode: "sarah" });
    expect(res.body.partner).toEqual({ status: "applied", discount: true });
  });

  it("checkout-intent says applied without a discount for a pack", async () => {
    const res = await post({ sku: SKU.starterPack, partnerCode: "sarah" });
    expect(res.body.partner).toEqual({ status: "applied", discount: false });
  });

  it("checkout-intent says invalid for an unknown code and still creates the checkout", async () => {
    const res = await post({ sku: SKU.starterPack, partnerCode: "nobody" });
    expect(res.status).toBe(200);
    expect(res.body.partner).toEqual({ status: "invalid", discount: false });
    expect(s.checkout.createCheckout).toHaveBeenCalledWith("acc-1", SKU.starterPack);
  });

  it("checkout-intent says none when no code was sent", async () => {
    const res = await post({ sku: SKU.starterPack });
    expect(res.body.partner).toEqual({ status: "none", discount: false });
  });

  it("an empty box is the same as no code", async () => {
    const res = await post({ sku: SKU.starterPack, partnerCode: "   " });
    expect(res.body.partner).toEqual({ status: "none", discount: false });
    expect(s.resolvePartnerCode).not.toHaveBeenCalled();
  });

  it("check: a valid code reports whether the first month discount is offered", async () => {
    const res = await check({ code: "sarah" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, discount: true });
    expect(s.resolvePartnerCode).toHaveBeenCalledWith("sarah", "acc-1");
  });

  it("check: no discount is promised when the discount is not configured", async () => {
    const res = await request(mount({ ...s, discountConfigured: () => false } as never)).post("/wallet/partner-code/check").send({ code: "sarah" });
    expect(res.body).toEqual({ valid: true, discount: false });
  });

  it("check: an unknown code, and a failing lookup, are valid false and never an error", async () => {
    expect((await check({ code: "nobody" })).body).toEqual({ valid: false, discount: false });
    s.resolvePartnerCode.mockRejectedValueOnce(new Error("db down"));
    const res = await check({ code: "sarah" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false, discount: false });
  });

  it("check needs a login", async () => {
    auth.mode = "none";
    expect((await check({ code: "sarah" })).status).toBe(401);
  });
});

describe("POST /wallet/teardown", () => {
  const post = (body: unknown, key: string | null = "click-1") => {
    const r = request(mount(s)).post("/wallet/teardown");
    if (key !== null) r.set("Idempotency-Key", key);
    return r.send(body as object);
  };

  it("requires an Idempotency-Key header", async () => {
    const res = await post({ input: "https://rival.example" }, null);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("idempotency_key_required");
    expect(s.runTeardown).not.toHaveBeenCalled();
  });

  it("refuses a key with characters the ledger would reject", async () => {
    for (const k of ["bad key", "a/b", "x".repeat(101)]) {
      expect((await post({ input: "https://rival.example" }, k)).status, k).toBe(400);
    }
    expect(s.runTeardown).not.toHaveBeenCalled();
  });

  it("requires an address to analyze", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ input: "" })).status).toBe(400);
    expect((await post({ input: 5 })).status).toBe(400);
  });

  it("runs the orchestrator for the signed in account and user, and passes the tier", async () => {
    const res = await post({ input: "https://rival.example", accountId: "forged" });
    expect(res.status).toBe(200);
    expect(s.runTeardown).toHaveBeenCalledWith({ accountId: "acc-1", userId: "user-1", tier: "free", idempotencyKey: "click-1", input: "https://rival.example" });
  });

  it("passes the orchestrator's refusal status and body straight through", async () => {
    s.runTeardown.mockResolvedValueOnce({ status: 402, body: { error: "insufficient_credits", balanceMicro: 0, requiredMicro: 10_000_000 } });
    const res = await post({ input: "https://rival.example" });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("insufficient_credits");
  });

  it("never puts a token or authorization in the answer", async () => {
    const res = await post({ input: "https://rival.example" });
    expect(JSON.stringify(res.body)).not.toMatch(/token|authorization|bearer|eyJ/i);
    expect(res.headers.authorization).toBeUndefined();
  });

  it("refuses an API key (a person is needed for the engine token)", async () => {
    auth.mode = "apiKey";
    expect((await post({ input: "https://rival.example" })).status).toBe(403);
    expect(s.runTeardown).not.toHaveBeenCalled();
  });

  it("answers 500 and logs when the orchestrator crashes", async () => {
    s.runTeardown.mockRejectedValueOnce(new Error("boom"));
    const res = await post({ input: "https://rival.example" });
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalled();
  });
});
