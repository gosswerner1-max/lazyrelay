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

const balanceView = { spendableMicro: 30_000_000, heldMicro: 0, byKindMicro: { signup: 30_000_000, pack: 0, subscription: 0 }, displayCredits: "30", heldCredits: "0", nextExpiryAt: null, nextExpiryCredits: null, activeHolds: 0 };

function stubs() {
  return {
    service: { getBalance: vi.fn(async (_id: string) => balanceView) },
    runTeardown: vi.fn(async (_i: any) => ({ status: 200, body: { analysis: {}, blueprint: {}, charged: true } })),
    getTier: vi.fn(async (_id: string) => "free" as any),
    readPacks: vi.fn(async () => [
      { sku: SKU.starterPack, name: "LazyCredits Starter Pack", kind: "pack", price_cents: 1500, credits: 300, expires: false, interval: "one_time", requires_plan: null, active: true },
    ]),
    checkout: { createCheckout: vi.fn(async (accountId: string, sku: string) => ({ checkoutId: `txn_${accountId}_${sku}` })) },
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
    expect(res.body).toEqual(balanceView);
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
