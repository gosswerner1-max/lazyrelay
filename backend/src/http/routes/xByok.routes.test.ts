// Connecting X with the customer's own keys, over HTTP: plan gate, flag gate, terms, validation, human-only, rate
// limits, Vault written once, rotation, isolation between accounts, disconnect wipe, and that no secret ever comes back.
// Login is mocked, supabase is the in-memory fake, X is a stubbed fetch. Nothing real is touched.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables, vault } from "../../testFakeSupabase.js";
import { X_TEST_BUNDLE } from "../../platforms/xTestKit.js";

const ctx = vi.hoisted(() => ({ account: "acc1", method: "jwt", selects: [] as string[], rpcCalls: [] as string[] }));
vi.mock("../auth.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.accountId = ctx.account;
      req.authMethod = ctx.method;
      req.db = {
        from: (t: string) => {
          const b: any = f.makeBuilder(t);
          const select = b.select;
          b.select = (cols?: string, o?: unknown) => {
            if (t === "social_accounts" && cols) ctx.selects.push(cols);
            return select(cols, o);
          };
          return b;
        },
      };
      next();
    },
    requireHumanAuth: (req: any, res: any, next: any) => {
      if (req.authMethod === "apiKey") {
        res.status(403).json({ error: "This endpoint requires signing in with your account, not an API key" });
        return;
      }
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => f.makeBuilder(t),
      rpc: (fn: string, args: Record<string, unknown>) => {
        ctx.rpcCalls.push(fn);
        return f.fakeRpc(fn, args);
      },
    },
  };
});
vi.mock("../../http/metaWebhook.js", () => ({ subscribePageToMessaging: vi.fn(async () => {}) }));

const { buildSocialAccountsRouter } = await import("./socialAccounts.routes.js");
const { registerXByokRoutes, X_BYOK_FAILED_VALIDATIONS_PER_DAY, xByokJsonParser } = await import("./xByok.routes.js");
const { XAdapter } = await import("../../platforms/x.js");
const { parseXBundle } = await import("../../platforms/xByok.js");
const { TIER_DISPLAY_NAMES } = await import("../../tier.js");
import type { Tier } from "../../tier.js";

const KEYS = { apiKey: X_TEST_BUNDLE.apiKey, apiSecret: X_TEST_BUNDLE.apiSecret, accessToken: X_TEST_BUNDLE.accessToken, accessTokenSecret: X_TEST_BUNDLE.accessTokenSecret };
const BODY = { ...KEYS, acceptedTerms: true };
const SECRETS = Object.values(KEYS);
const leaks = (v: unknown) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return SECRETS.some((s) => t.includes(s));
};

let xCalls: number;
let xReply: () => Response;
const meOk = (id = "42", username = "acme") => () => new Response(JSON.stringify({ data: { id, username, name: "Acme" } }), { status: 200 });

const registry = () => new Map([["x", new XAdapter()]]) as never;
function appWith(reg = registry(), opts?: { rateMax?: number }) {
  const a = express();
  a.use("/social-accounts/x/byok", ...xByokJsonParser); // mounted before the global parser, as in app.ts
  a.use(express.json());
  a.use(buildSocialAccountsRouter(reg));
  if (opts) {
    // a second copy of just the X routes with a raised limit, for the daily-cap test
    const b = express();
    b.use("/social-accounts/x/byok", ...xByokJsonParser);
    b.use(express.json());
    const r = express.Router();
    registerXByokRoutes(r, reg, () => true, opts);
    b.use(r);
    return b;
  }
  return a;
}
const setTier = (tier: Tier, account = "acc1") => {
  tables.subscriptions = (tables.subscriptions ?? []).filter((r) => r.account_id !== account);
  tables.subscriptions.push({ account_id: account, tier, status: "active" });
};

let errorLog: unknown[][];
beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  tables.social_accounts = [];
  ctx.account = "acc1";
  ctx.method = "jwt";
  ctx.selects = [];
  ctx.rpcCalls = [];
  xCalls = 0;
  xReply = meOk();
  process.env.X_BYOK_PLATFORM_PUBLIC = "true";
  setTier("pro");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      xCalls += 1;
      return xReply();
    }),
  );
  errorLog = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void errorLog.push(a));
  vi.spyOn(console, "warn").mockImplementation((...a) => void errorLog.push(a));
  vi.spyOn(console, "log").mockImplementation((...a) => void errorLog.push(a));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ["X_BYOK_PLATFORM_PUBLIC", "X_BYOK_TEST_ACCOUNT_IDS", "X_BYOK_ENABLED"]) delete process.env[k];
});

describe("plan gate: Pro, Business, Agency and Agency Plus only", () => {
  const cases: Array<[Tier, boolean]> = [["free", false], ["starter", false], ["pro", true], ["business", true], ["agency", true], ["agency_plus", true]];
  for (const [tier, allowed] of cases) {
    it(`${TIER_DISPLAY_NAMES[tier]} is ${allowed ? "allowed" : "refused"} on the keys route, the check route, the connect route and the tile`, async () => {
      setTier(tier);
      const save = await request(appWith()).post("/social-accounts/x/byok").send(BODY);
      const check = await request(appWith()).post("/social-accounts/x/byok/check").send(KEYS);
      const connect = await request(appWith()).get("/social-accounts/connect?platform=x");
      const tile = (await request(appWith()).get("/platforms")).body.find((p: { platform: string }) => p.platform === "x");
      expect(tile).toMatchObject({ platform: "x", configured: true, comingSoon: false, requiresPlan: "Pro", allowed });
      if (allowed) {
        expect(save.status).toBe(200);
        expect(check.status).toBe(200);
        expect(connect.status).toBe(400); // pointed at the keys form, no OAuth redirect
        expect(connect.body.error).toMatch(/own developer keys/);
      } else {
        expect(save.status).toBe(403);
        expect(check.status).toBe(403);
        expect(connect.status).toBe(403);
        expect(save.body).toMatchObject({ requiresPlan: "Pro" });
        expect(save.body.error).toMatch(/Pro plan and above/);
        expect(vault.size).toBe(0); // nothing stored, and the check route stored nothing either
        expect(tables.social_accounts).toHaveLength(0);
      }
      expect(leaks([save.body, check.body, connect.body])).toBe(false);
    });
  }

  it("a refused plan never reaches X", async () => {
    setTier("starter");
    await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    expect(xCalls).toBe(0);
  });

  it("an account with no subscription row counts as Free", async () => {
    tables.subscriptions = [];
    expect((await request(appWith()).post("/social-accounts/x/byok").send(BODY)).status).toBe(403);
  });

  it("a cancelled paid plan counts as Free", async () => {
    tables.subscriptions = [{ account_id: "acc1", tier: "pro", status: "cancelled" }];
    expect((await request(appWith()).post("/social-accounts/x/byok").send(BODY)).status).toBe(403);
  });
});

describe("flag gate", () => {
  it("X is hidden and refused when not registered (X_BYOK_ENABLED off), on every route", async () => {
    const off = new Map() as never;
    expect((await request(appWith(off)).get("/platforms")).body.map((p: { platform: string }) => p.platform)).not.toContain("x");
    for (const path of ["/social-accounts/x/byok", "/social-accounts/x/byok/check"]) {
      const r = await request(appWith(off)).post(path).send(BODY);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/isn't available to connect yet/);
    }
    expect(xCalls).toBe(0);
    expect(vault.size).toBe(0);
  });

  it("registered but not switched on: hidden and refused until X_BYOK_PLATFORM_PUBLIC or the test list opens it", async () => {
    delete process.env.X_BYOK_PLATFORM_PUBLIC;
    expect((await request(appWith()).get("/platforms")).body.map((p: { platform: string }) => p.platform)).not.toContain("x");
    expect((await request(appWith()).post("/social-accounts/x/byok").send(BODY)).status).toBe(400);
    process.env.X_BYOK_TEST_ACCOUNT_IDS = "someone, acc1";
    expect((await request(appWith()).get("/platforms")).body.map((p: { platform: string }) => p.platform)).toContain("x");
    expect((await request(appWith()).post("/social-accounts/x/byok").send(BODY)).status).toBe(200);
    ctx.account = "acc9";
    setTier("pro", "acc9");
    expect((await request(appWith()).post("/social-accounts/x/byok").send(BODY)).status).toBe(400);
  });

  it("the other platforms' switches do not open it", async () => {
    delete process.env.X_BYOK_PLATFORM_PUBLIC;
    for (const k of ["SLACK_PLATFORM_PUBLIC", "NOSTR_PLATFORM_PUBLIC", "WHOP_PLATFORM_PUBLIC", "ARTICLE_PLATFORMS_PUBLIC"]) process.env[k] = "true";
    expect((await request(appWith()).post("/social-accounts/x/byok").send(BODY)).status).toBe(400);
    for (const k of ["SLACK_PLATFORM_PUBLIC", "NOSTR_PLATFORM_PUBLIC", "WHOP_PLATFORM_PUBLIC", "ARTICLE_PLATFORMS_PUBLIC"]) delete process.env[k];
  });
});

describe("terms and human-only", () => {
  it("the terms must be accepted with a real boolean true", async () => {
    for (const acceptedTerms of [undefined, false, "true", 1, null]) {
      const r = await request(appWith()).post("/social-accounts/x/byok").send({ ...KEYS, ...(acceptedTerms === undefined ? {} : { acceptedTerms }) });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/accept the terms/);
    }
    expect(xCalls).toBe(0);
    expect(vault.size).toBe(0);
  });

  it("an API key cannot use the keys routes", async () => {
    ctx.method = "apiKey";
    for (const path of ["/social-accounts/x/byok", "/social-accounts/x/byok/check"]) {
      const r = await request(appWith()).post(path).send(BODY);
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/not an API key/);
    }
    expect(xCalls).toBe(0);
    expect(vault.size).toBe(0);
  });
});

describe("validation bounds", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["missing apiKey", { apiKey: undefined }],
    ["empty apiSecret", { apiSecret: "" }],
    ["too short accessToken", { accessToken: "abc" }],
    ["too long accessTokenSecret", { accessTokenSecret: "a".repeat(201) }],
    ["a space inside", { apiKey: "abcd efghijkl" }],
    ["a newline inside", { apiSecret: "abcdefgh\nijklmnop" }],
    ["a symbol outside the charset", { accessToken: "abcdefghij$klmnop" }],
    ["a non-string", { apiKey: 12345678901 }],
    ["an object", { apiSecret: { x: 1 } }],
  ];
  for (const [name, over] of bad) {
    it(`${name} is refused with a message that never repeats the value`, async () => {
      const body = { ...BODY, ...over };
      const r = await request(appWith()).post("/social-accounts/x/byok").send(body);
      expect(r.status).toBe(400);
      expect(xCalls).toBe(0);
      for (const v of Object.values(over)) if (typeof v === "string" && v.length > 3) expect(r.text.includes(v)).toBe(false);
      expect(leaks(r.body)).toBe(false);
    });
  }

  it("surrounding whitespace is trimmed, then the value is accepted", async () => {
    const r = await request(appWith()).post("/social-accounts/x/byok").send({ ...BODY, apiKey: `  ${KEYS.apiKey}\t` });
    expect(r.status).toBe(200);
    expect(parseXBundle([...vault.values()][0])!.apiKey).toBe(KEYS.apiKey);
  });

  it("a malformed JSON body gets a fixed answer, echoes nothing and logs nothing from the body", async () => {
    const r = await request(appWith()).post("/social-accounts/x/byok").set("Content-Type", "application/json").send(`{"apiKey":"${KEYS.apiKey}", "apiSecret": "${KEYS.apiSecret}", oops`);
    expect(r.status).toBe(400);
    expect(leaks(r.text)).toBe(false);
    expect(leaks(errorLog)).toBe(false);
    expect(xCalls).toBe(0);
  });

  it("a body over 4 KB is refused before anything else", async () => {
    const r = await request(appWith()).post("/social-accounts/x/byok").send({ ...BODY, padding: "a".repeat(5000) });
    expect(r.status).toBe(400);
    expect(xCalls).toBe(0);
    expect(vault.size).toBe(0);
  });
});

describe("what X says about the keys", () => {
  const cases: Array<[string, number, unknown, number, RegExp]> = [
    ["401", 401, { title: "Unauthorized" }, 400, /did not accept these keys/],
    ["403", 403, { title: "Forbidden" }, 400, /Read and Write permission/],
    ["402 credits", 402, { title: "CreditsDepleted" }, 400, /no credits/],
    ["429", 429, { title: "Too Many Requests" }, 429, /limiting requests/],
    ["503", 503, {}, 502, /Could not reach X/],
  ];
  for (const [name, status, body, expectStatus, message] of cases) {
    it(`${name} gets a fixed message, stores nothing, and echoes no key or X body`, async () => {
      xReply = () => new Response(JSON.stringify({ ...(body as object), detail: `echo ${KEYS.accessTokenSecret}` }), { status });
      const r = await request(appWith()).post("/social-accounts/x/byok").send(BODY);
      expect(r.status).toBe(expectStatus);
      expect(r.body.error).toMatch(message);
      expect(r.text).not.toContain("echo");
      expect(leaks([r.body, errorLog])).toBe(false);
      expect(vault.size).toBe(0);
      expect(tables.social_accounts).toHaveLength(0);
    });
  }

  it("a network failure is the same fixed answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`down ${KEYS.apiSecret}`); }));
    const r = await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    expect(r.status).toBe(502);
    expect(leaks([r.body, errorLog])).toBe(false);
  });
});

describe("saving a connection", () => {
  it("writes Vault once, stores the four values as one JSON string, and answers { ok, handle, keyHint } only", async () => {
    const r = await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, handle: "acme", keyHint: "****abcd" });
    expect(leaks(r.body)).toBe(false);
    expect(ctx.rpcCalls.filter((f) => f === "store_social_token")).toHaveLength(1);
    expect(vault.size).toBe(1);
    expect(parseXBundle([...vault.values()][0])).toEqual(KEYS);
    expect(tables.social_accounts).toHaveLength(1);
    expect(tables.social_accounts[0]).toMatchObject({
      account_id: "acc1",
      platform: "x",
      platform_account_id: "42",
      display_name: "acme",
      credential_mode: "byok",
      byok_status: "valid",
      byok_key_hint: "****abcd",
      token_expires_at: null,
      refresh_token_vault_id: null,
      disconnected_at: null,
    });
    expect(tables.social_accounts[0].byok_validated_at).toBeTruthy();
    expect(leaks({ ...tables.social_accounts[0], access_token_vault_id: undefined })).toBe(false); // no key material in the row itself
  });

  it("rotating the keys of the same X account overwrites the old secret in place: still one secret, one row", async () => {
    await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    const vaultId = tables.social_accounts[0].access_token_vault_id as string;
    const fresh = { ...BODY, apiSecret: "ROTATEDsecret0123456789abcdefghijklmnopqrstuv", accessTokenSecret: "ROTATEDtokensecret0123456789abcdefghijklmn" };
    const r = await request(appWith()).post("/social-accounts/x/byok").send(fresh);
    expect(r.status).toBe(200);
    expect(vault.size).toBe(1);
    expect(ctx.rpcCalls.filter((f) => f === "store_social_token")).toHaveLength(1);
    expect(ctx.rpcCalls).toContain("update_social_token");
    expect(tables.social_accounts).toHaveLength(1);
    expect(tables.social_accounts[0].access_token_vault_id).toBe(vaultId);
    const stored = parseXBundle(vault.get(vaultId))!;
    expect(stored.apiSecret).toBe(fresh.apiSecret);
    expect([...vault.values()].some((v) => v.includes(KEYS.apiSecret))).toBe(false); // the old secret is gone
  });

  it("rotation after the X side was marked invalid puts the status back to valid and clears the reconnect flag", async () => {
    await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    Object.assign(tables.social_accounts[0], { byok_status: "invalid", needs_reconnect_at: "2026-10-01", needs_reconnect_reason: "x", reconnect_notified_at: "2026-10-01" });
    await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    expect(tables.social_accounts[0]).toMatchObject({ byok_status: "valid", needs_reconnect_at: null, needs_reconnect_reason: null, reconnect_notified_at: null });
  });

  it("a different X account is a second connection with its own secret", async () => {
    await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    xReply = meOk("43", "other");
    await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    expect(tables.social_accounts).toHaveLength(2);
    expect(vault.size).toBe(2);
  });

  it("two LazyRelay accounts connecting the same X account never touch each other", async () => {
    await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    const first = { ...tables.social_accounts[0] };
    ctx.account = "acc2";
    setTier("business", "acc2");
    const other = { ...BODY, apiKey: "SECONDaccountKEY0123456789" };
    await request(appWith()).post("/social-accounts/x/byok").send(other);
    expect(tables.social_accounts).toHaveLength(2);
    const mine = tables.social_accounts.find((r) => r.account_id === "acc1")!;
    expect(mine).toMatchObject({ access_token_vault_id: first.access_token_vault_id, byok_key_hint: "****abcd" });
    expect(parseXBundle(vault.get(first.access_token_vault_id as string))!.apiKey).toBe(KEYS.apiKey);
    expect(tables.social_accounts.find((r) => r.account_id === "acc2")!.access_token_vault_id).not.toBe(first.access_token_vault_id);
  });

  it("respects the plan's connected-account limit for a new connection, but never blocks a rotation", async () => {
    await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    for (let i = 0; i < 29; i++) tables.social_accounts.push({ id: `f${i}`, account_id: "acc1", platform: "bluesky", platform_account_id: `b${i}`, disconnected_at: null, connected_at: new Date().toISOString() });
    const rotate = await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    expect(rotate.status).toBe(200);
    xReply = meOk("99", "brandnew");
    const fresh = await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    expect(fresh.status).toBe(403);
    expect(fresh.body.error).toMatch(/limit of 30 connected accounts/);
    expect(vault.size).toBe(1);
  });

  it("the check route proves the keys and shows the handle but stores nothing", async () => {
    const r = await request(appWith()).post("/social-accounts/x/byok/check").send(KEYS);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, handle: "acme", keyHint: "****abcd" });
    expect(vault.size).toBe(0);
    expect(tables.social_accounts).toHaveLength(0);
    expect(ctx.rpcCalls).toEqual([]);
  });
});

describe("rate limits", () => {
  it("allows 5 tries per 15 minutes per account, then refuses without calling X", async () => {
    const app = appWith();
    for (let i = 0; i < 5; i++) expect((await request(app).post("/social-accounts/x/byok/check").send(KEYS)).status).toBe(200);
    const sixth = await request(app).post("/social-accounts/x/byok").send(BODY);
    expect(sixth.status).toBe(429);
    expect(xCalls).toBe(5);
    expect(leaks(sixth.body)).toBe(false);
  });

  it("the limit is per IP as well: other accounts from the same address share it", async () => {
    const app = appWith();
    for (let i = 0; i < 5; i++) {
      ctx.account = `acc-${i}`;
      setTier("pro", `acc-${i}`);
      expect((await request(app).post("/social-accounts/x/byok/check").send(KEYS)).status).toBe(200);
    }
    ctx.account = "acc-new";
    setTier("pro", "acc-new");
    expect((await request(app).post("/social-accounts/x/byok/check").send(KEYS)).status).toBe(429);
  });

  it("a daily cap on keys X rejected stops further tries without calling X", async () => {
    xReply = () => new Response(JSON.stringify({ title: "Unauthorized" }), { status: 401 });
    const app = appWith(registry(), { rateMax: 1000 });
    for (let i = 0; i < X_BYOK_FAILED_VALIDATIONS_PER_DAY; i++) expect((await request(app).post("/social-accounts/x/byok/check").send(KEYS)).status).toBe(400);
    const before = xCalls;
    const capped = await request(app).post("/social-accounts/x/byok/check").send(KEYS);
    expect(capped.status).toBe(429);
    expect(capped.body.error).toMatch(/tomorrow/);
    expect(xCalls).toBe(before);
  });
});

describe("listing and disconnecting", () => {
  it("GET /social-accounts exposes credentialMode, byokStatus and byokKeyHint, selects explicit columns, and carries no key material", async () => {
    process.env.X_BYOK_ENABLED = "true";
    await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    const r = await request(appWith()).get("/social-accounts");
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ platform: "x", credentialMode: "byok", byokStatus: "valid", byokKeyHint: "****abcd" });
    expect(leaks(r.body)).toBe(false);
    const cols = ctx.selects.filter((c) => c.includes("display_name")).pop()!;
    expect(cols).toContain("credential_mode, byok_status, byok_key_hint");
    expect(cols).not.toMatch(/\*|vault|token/);
  });

  it("without X_BYOK_ENABLED the list does not touch the new columns at all", async () => {
    await request(appWith()).get("/social-accounts");
    expect(ctx.selects.filter((c) => c.includes("display_name")).pop()).not.toMatch(/byok|credential_mode/);
  });

  it("disconnecting overwrites the stored bundle, so none of the four keys survives in Vault", async () => {
    await request(appWith()).post("/social-accounts/x/byok").send(BODY);
    const id = tables.social_accounts[0].id as string;
    const vaultId = tables.social_accounts[0].access_token_vault_id as string;
    expect(parseXBundle(vault.get(vaultId))).not.toBeNull();
    const del = await request(appWith()).delete(`/social-accounts/${id}`);
    expect(del.status).toBe(204);
    expect(vault.get(vaultId)).toBe("revoked");
    expect([...vault.values()].some((v) => leaks(v))).toBe(false);
    expect(tables.social_accounts[0].tokens_wiped_at).toBeTruthy();
  });
});

describe("no response, row or log ever contains key material", () => {
  it("across success, every refusal and every X failure", async () => {
    const outputs: unknown[] = [];
    const run = async (fn: () => Promise<{ text: string }>) => outputs.push((await fn()).text);
    await run(() => request(appWith()).post("/social-accounts/x/byok").send(BODY));
    await run(() => request(appWith()).post("/social-accounts/x/byok").send({ ...BODY, acceptedTerms: false }));
    await run(() => request(appWith()).post("/social-accounts/x/byok").send({ ...BODY, apiKey: "bad key!" }));
    setTier("free");
    await run(() => request(appWith()).post("/social-accounts/x/byok").send(BODY));
    setTier("pro");
    for (const status of [401, 402, 403, 429, 500]) {
      xReply = () => new Response(JSON.stringify({ title: "x", detail: KEYS.accessTokenSecret }), { status });
      await run(() => request(appWith()).post("/social-accounts/x/byok").send(BODY));
    }
    await run(() => request(appWith()).get("/social-accounts"));
    await run(() => request(appWith()).get("/platforms"));
    expect(outputs.some((t) => leaks(t as string))).toBe(false);
    expect(leaks(errorLog)).toBe(false);
  });
});
