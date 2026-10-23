// Contract tests: the REAL wallet router, the REAL balance service and the REAL Paddle checkout port (only the network, the database and
// the login are faked), compared with the files in /contracts. The frontend tests (frontend/src/lib/walletContract.test.ts) feed the very
// same files into the REAL client code. If the server's answer and the client's reader ever drift apart again, one of the two fails.
// To refresh the files after an intended change: UPDATE_CONTRACTS=1 npx vitest run src/http/routes/wallet.contract.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

vi.mock("../auth.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../auth.js")>();
  return {
    ...real,
    requireAuth: (req: any, _res: any, next: any) => {
      req.authMethod = "jwt";
      req.accountId = "6f1d0a52-3c1e-4e0a-9d6e-0b4b8d8f2a11";
      req.userId = "user-1";
      req.role = "owner";
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});

const { buildWalletRouter } = await import("./wallet.routes.js");
const { createWalletService } = await import("../../wallet/service.js");
const { createPaddleCheckoutPort } = await import("../../billing/checkout.js");
const { SKU } = await import("../../wallet/catalog.js");
const { WALLET_ENV } = await import("../../billing/walletFixtures.testHelper.js");

const ACCOUNT = "6f1d0a52-3c1e-4e0a-9d6e-0b4b8d8f2a11";
const NOW = new Date("2026-10-23T10:00:00.000Z");
const CONTRACTS = resolve(__dirname, "../../../../contracts");

/** Compares with (or, with UPDATE_CONTRACTS=1, rewrites) a contract file. A missing file fails: nothing is created by accident. */
function matchesContract(name: string, actual: unknown): void {
  const file = resolve(CONTRACTS, name);
  if (process.env.UPDATE_CONTRACTS === "1") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(actual, null, 2) + "\n");
  }
  expect(existsSync(file), `contract file ${name} is missing`).toBe(true);
  expect(actual).toEqual(JSON.parse(readFileSync(file, "utf8")));
}

/** A fake of the network that behaves like Node's fetch where it matters: a GET or HEAD with a body is refused before anything is sent. */
function fetchLike() {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  const http = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    if ((init.method === "GET" || init.method === "HEAD") && init.body !== undefined) throw new TypeError("Request with GET/HEAD method cannot have body.");
    calls.push({ url, method: init.method, body: init.body });
    const reply = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    if (url.includes("/customers?email=")) return reply({ data: [{ id: "ctm_fake_1" }] });
    if (url.endsWith("/transactions")) return reply({ data: { id: "txn_fake_new", checkout: { url: "https://lazyrelay.com/?_ptxn=txn_fake_new" } } });
    throw new Error(`unexpected request ${init.method} ${url}`);
  });
  return { http, calls };
}

function app(net: ReturnType<typeof fetchLike>) {
  const service = createWalletService({
    ledger: {
      balance: async () => ({ spendableMicro: 1_830_000_000, heldMicro: 5_000_000, nextExpiryAt: "2026-11-10T12:00:00.000Z", nextExpiryMicro: 1_200_000_000 }),
      grant: vi.fn(),
    },
    readLots: async () => ({
      lots: [
        { kind: "subscription", remainingMicro: 1_200_000_000, reservedMicro: 0, expiresAt: "2026-11-10T12:00:00.000Z", boundPlan: null },
        { kind: "pack", remainingMicro: 605_000_000, reservedMicro: 5_000_000, expiresAt: null, boundPlan: null },
        { kind: "signup", remainingMicro: 30_000_000, reservedMicro: 0, expiresAt: null, boundPlan: null },
      ],
      activeHolds: 1,
    }),
    isLegacy: async () => false,
    isEmailConfirmed: async () => true,
    now: () => NOW,
  });
  const a = express();
  a.use(express.json());
  a.use(
    "/wallet",
    buildWalletRouter({
      service,
      getTier: async () => "lazy_pro",
      isLegacy: async () => false,
      isCancelPending: async () => false,
      readPacks: async () => [],
      resolvePartnerCode: async () => null,
      checkout: createPaddleCheckoutPort({ apiKey: "pdl_fake_key", http: net.http as never, env: { ...WALLET_ENV, PADDLE_ENVIRONMENT: "production" }, emailForAccount: async () => "buyer@example.org" }),
    }),
  );
  return a;
}

const saved = { enabled: process.env.WALLET_ENABLED, mode: process.env.WALLET_MODE };
beforeEach(() => {
  process.env.WALLET_ENABLED = "true";
  process.env.WALLET_MODE = "on";
});
afterEach(() => {
  for (const [k, v] of [["WALLET_ENABLED", saved.enabled], ["WALLET_MODE", saved.mode]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("GET /wallet/balance (real service, real route)", () => {
  it("answers in the shape the website reads, and the answer is the contract file", async () => {
    const res = await request(app(fetchLike())).get("/wallet/balance");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exempt: false, balance: 1830, held: 5, paused: false });
    expect(res.body.plan).toEqual({ tier: "lazy_pro", walletPlan: "pro", caps: { accounts: 1000, brands: null, queued: null } });
    expect(res.body.prices).toEqual({ post_publish: 1, competitor_teardown: 10 });
    expect(res.body.nextExpiry).toEqual({ at: "2026-11-10T12:00:00.000Z", credits: 1200 });
    matchesContract("wallet-balance.json", res.body);
  });
});

describe("POST /wallet/checkout-intent (real route, real Paddle port, fetch-like network)", () => {
  it("works for a buyer with a known email (the customer lookup is a GET with no body) and answers in the shape the website reads", async () => {
    const net = fetchLike();
    const res = await request(app(net)).post("/wallet/checkout-intent").send({ sku: SKU.growthPlan });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ transactionId: "txn_fake_new", checkoutUrl: "https://lazyrelay.com/?_ptxn=txn_fake_new", sku: SKU.growthPlan });
    expect(res.body.checkout).toMatchObject({ transactionId: "txn_fake_new" }); // the nested object stays for existing readers
    expect(net.calls.find((c) => c.url.includes("/customers?email="))?.body).toBeUndefined();
    matchesContract("wallet-checkout-intent.json", res.body);
  });
});
