// Connecting WhatsApp with the customer's own Meta credentials, over HTTP: the Business-and-above plan gate (HTTP 400),
// flag gate, human-only, validation, the Vault write (token encrypted there and nowhere else), rotation, and that the
// token never comes back in a response, a row, a column list or a log line. Login is mocked, supabase is the in-memory
// fake, Meta is a stubbed fetch. Nothing real is touched, and Meta's live Graph API is NOT exercised.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tables, vault } from "../../testFakeSupabase.js";

const ctx = vi.hoisted(() => ({ account: "acc1", method: "jwt", selects: [] as string[], rpcCalls: [] as string[], dbGateError: null as null | { code?: string; message: string } }));
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
      from: (t: string) => {
        const b: any = f.makeBuilder(t);
        // Tests only: make the next social_accounts write fail the way the 0125 database trigger would.
        if (t === "social_accounts" && ctx.dbGateError) {
          b.upsert = () => ({ then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: ctx.dbGateError }).then(resolve) });
        }
        return b;
      },
      rpc: (fn: string, args: Record<string, unknown>) => {
        ctx.rpcCalls.push(fn);
        return f.fakeRpc(fn, args);
      },
    },
  };
});
vi.mock("../../http/metaWebhook.js", () => ({ subscribePageToMessaging: vi.fn(async () => {}) }));

const { buildSocialAccountsRouter } = await import("./socialAccounts.routes.js");
const { registerWhatsAppByokRoutes, WHATSAPP_BYOK_FAILED_VALIDATIONS_PER_DAY, whatsappByokJsonParser } = await import("./whatsappByok.routes.js");
const { WhatsAppAdapter } = await import("../../platforms/whatsapp/adapter.js");
const { parseWhatsAppBundle } = await import("../../platforms/whatsapp/credentials.js");
const { WHATSAPP_BYOK_ALLOWED_TIERS, canUseWhatsappByok } = await import("../../tier.js");
const { checkWhatsappPlan, isWhatsappPlanGateError, WHATSAPP_DB_GATE_CODE, WHATSAPP_DB_GATE_MESSAGE, WHATSAPP_PLAN_MESSAGE } = await import("../../accountLimits.js");
import type { Tier } from "../../tier.js";

// Fake values that merely look the right shape. None is a real Meta credential.
const TOKEN = "test_whatsapp_system_user_token_not_real_0123456789";
const WABA = "123456789012345";
const PHONE = "109876543210987";
const CREDS = { wabaId: WABA, phoneNumberId: PHONE, systemUserToken: TOKEN };
const BODY = { ...CREDS, acceptedTerms: true };
const leaks = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)).includes(TOKEN);

let metaCalls: string[];
let metaAuth: Array<string | null>;
let metaReply: (url: string) => Response;
const metaOk = (url: string) =>
  url.includes("/phone_numbers")
    ? new Response(JSON.stringify({ data: [{ id: PHONE }] }), { status: 200 })
    : new Response(JSON.stringify({ id: PHONE, verified_name: "Acme Cafe", display_phone_number: "+27 82 000 0000" }), { status: 200 });

const registry = () => new Map([["whatsapp", new WhatsAppAdapter()]]) as never;
function appWith(reg = registry(), opts?: { rateMax?: number }) {
  const a = express();
  a.use("/social-accounts/whatsapp/byok", ...whatsappByokJsonParser); // mounted before the global parser, as in app.ts
  a.use(express.json());
  a.use(buildSocialAccountsRouter(reg));
  if (opts) {
    // a copy of just the WhatsApp routes with a raised limit, for the daily-cap test
    const b = express();
    b.use("/social-accounts/whatsapp/byok", ...whatsappByokJsonParser);
    b.use(express.json());
    const r = express.Router();
    registerWhatsAppByokRoutes(r, reg, () => true, opts);
    b.use(r);
    return b;
  }
  return a;
}
const setTier = (tier: Tier, account = "acc1") => {
  tables.subscriptions = (tables.subscriptions ?? []).filter((r) => r.account_id !== account);
  tables.subscriptions.push({ account_id: account, tier, status: "active" });
};

let logged: unknown[][];
beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  tables.social_accounts = [];
  ctx.account = "acc1";
  ctx.method = "jwt";
  ctx.selects = [];
  ctx.rpcCalls = [];
  ctx.dbGateError = null;
  metaCalls = [];
  metaAuth = [];
  metaReply = metaOk;
  process.env.WHATSAPP_BYOK_PLATFORM_PUBLIC = "true";
  setTier("business");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      metaCalls.push(String(url));
      metaAuth.push(new Headers(init?.headers).get("authorization"));
      return metaReply(String(url));
    }),
  );
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a));
  vi.spyOn(console, "warn").mockImplementation((...a) => void logged.push(a));
  vi.spyOn(console, "log").mockImplementation((...a) => void logged.push(a));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ["WHATSAPP_BYOK_PLATFORM_PUBLIC", "WHATSAPP_BYOK_TEST_ACCOUNT_IDS", "WHATSAPP_BYOK_ENABLED", "X_BYOK_PLATFORM_PUBLIC"]) delete process.env[k];
});

describe("plan gate: Business, Agency and Agency Plus only; everything below answers HTTP 400", () => {
  const cases: Array<[Tier, boolean]> = [
    ["free", false],
    ["starter", false],
    ["pro", false],
    ["business", true],
    ["agency", true],
    ["agency_plus", true],
  ];
  for (const [tier, allowed] of cases) {
    it(`${tier} is ${allowed ? "allowed" : "refused with 400"} on the save route, the check route, the connect route and the tile`, async () => {
      setTier(tier);
      const save = await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
      const check = await request(appWith()).post("/social-accounts/whatsapp/byok/check").send(CREDS);
      const connect = await request(appWith()).get("/social-accounts/connect?platform=whatsapp");
      const tile = (await request(appWith()).get("/platforms")).body.find((p: { platform: string }) => p.platform === "whatsapp");
      expect(tile).toMatchObject({ platform: "whatsapp", configured: true, comingSoon: false, requiresPlan: "Business", allowed });
      if (allowed) {
        expect(save.status).toBe(200);
        expect(check.status).toBe(200);
        expect(connect.status).toBe(400); // pointed at the credentials form, no OAuth redirect
        expect(connect.body.error).toMatch(/own Meta credentials/);
        expect(vault.size).toBe(1);
      } else {
        // The specified status for this feature is 400 (the X route answers 403).
        expect(save.status).toBe(400);
        expect(check.status).toBe(400);
        expect(connect.status).toBe(400);
        expect(save.body).toMatchObject({ requiresPlan: "Business" });
        expect(save.body.error).toMatch(/Business plan and above/);
        expect(connect.body.error).toMatch(/Business plan and above/);
        expect(vault.size).toBe(0); // nothing stored, and the check route stored nothing either
        expect(tables.social_accounts).toHaveLength(0);
        expect(metaCalls).toHaveLength(0); // a refused plan never reaches Meta
      }
      expect(leaks([save.body, check.body, connect.body])).toBe(false);
    });
  }

  it("the allow-list is exactly business, agency and agency_plus", () => {
    expect([...WHATSAPP_BYOK_ALLOWED_TIERS].sort()).toEqual(["agency", "agency_plus", "business"]);
    for (const t of ["free", "starter", "pro"] as Tier[]) expect(canUseWhatsappByok(t), t).toBe(false);
  });

  it("an account with no subscription row counts as Free", async () => {
    tables.subscriptions = [];
    expect((await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY)).status).toBe(400);
    expect(await checkWhatsappPlan("acc1")).toMatch(/Business plan and above/);
  });

  it("a cancelled or past-due paid plan counts as Free", async () => {
    for (const status of ["cancelled", "past_due"]) {
      tables.subscriptions = [{ account_id: "acc1", tier: "business", status }];
      expect((await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY)).status, status).toBe(400);
    }
    expect(vault.size).toBe(0);
  });

  it("fails closed: if the plan cannot be read, the answer is 'not allowed'", async () => {
    tables.subscriptions = undefined as never; // makes the fake query throw
    expect(await checkWhatsappPlan("acc1")).toMatch(/Business plan and above/);
  });
});

describe("flag gate", () => {
  it("WhatsApp is hidden and refused when not registered (WHATSAPP_BYOK_ENABLED off), on every route", async () => {
    const off = new Map() as never;
    expect((await request(appWith(off)).get("/platforms")).body.map((p: { platform: string }) => p.platform)).not.toContain("whatsapp");
    for (const path of ["/social-accounts/whatsapp/byok", "/social-accounts/whatsapp/byok/check"]) {
      const r = await request(appWith(off)).post(path).send(BODY);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/isn't available to connect yet/);
    }
    expect(metaCalls).toHaveLength(0);
    expect(vault.size).toBe(0);
  });

  it("registered but not switched on: hidden and refused until the public flag or the test list opens it", async () => {
    delete process.env.WHATSAPP_BYOK_PLATFORM_PUBLIC;
    expect((await request(appWith()).get("/platforms")).body.map((p: { platform: string }) => p.platform)).not.toContain("whatsapp");
    expect((await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY)).status).toBe(400);
    process.env.WHATSAPP_BYOK_TEST_ACCOUNT_IDS = "someone, acc1";
    expect((await request(appWith()).get("/platforms")).body.map((p: { platform: string }) => p.platform)).toContain("whatsapp");
    expect((await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY)).status).toBe(200);
    ctx.account = "acc9";
    setTier("business", "acc9");
    expect((await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY)).status).toBe(400);
  });

  it("the other platforms' switches do not open it", async () => {
    delete process.env.WHATSAPP_BYOK_PLATFORM_PUBLIC;
    for (const k of ["SLACK_PLATFORM_PUBLIC", "NOSTR_PLATFORM_PUBLIC", "WHOP_PLATFORM_PUBLIC", "X_BYOK_PLATFORM_PUBLIC", "ARTICLE_PLATFORMS_PUBLIC"]) process.env[k] = "true";
    try {
      expect((await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY)).status).toBe(400);
      expect((await request(appWith()).get("/platforms")).body.map((p: { platform: string }) => p.platform)).not.toContain("whatsapp");
    } finally {
      for (const k of ["SLACK_PLATFORM_PUBLIC", "NOSTR_PLATFORM_PUBLIC", "WHOP_PLATFORM_PUBLIC", "ARTICLE_PLATFORMS_PUBLIC"]) delete process.env[k];
    }
  });
});

describe("who may call it", () => {
  it("an API key is refused: only a signed-in human may link credentials", async () => {
    ctx.method = "apiKey";
    for (const path of ["/social-accounts/whatsapp/byok", "/social-accounts/whatsapp/byok/check"]) {
      expect((await request(appWith()).post(path).send(BODY)).status).toBe(403);
    }
    expect(vault.size).toBe(0);
    expect(metaCalls).toHaveLength(0);
  });
});

describe("validation", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["a missing WABA id", { ...BODY, wabaId: undefined }],
    ["a non-numeric WABA id", { ...BODY, wabaId: "abc12345" }],
    ["a non-numeric phone number id", { ...BODY, phoneNumberId: "+27 82 000 0000" }],
    ["a token that is too short", { ...BODY, systemUserToken: "short" }],
    ["a token with spaces", { ...BODY, systemUserToken: "token with spaces 0123456789 0123456789" }],
    ["a token that is far too long", { ...BODY, systemUserToken: "a".repeat(600) }],
  ];
  for (const [label, body] of bad) {
    it(`rejects ${label} before anything reaches Meta or Vault`, async () => {
      const r = await request(appWith()).post("/social-accounts/whatsapp/byok").send(body);
      expect(r.status).toBe(400);
      expect(metaCalls).toHaveLength(0);
      expect(vault.size).toBe(0);
      expect(leaks(r.body)).toBe(false);
    });
  }

  it("saving needs the terms ticked; checking does not", async () => {
    const save = await request(appWith()).post("/social-accounts/whatsapp/byok").send(CREDS);
    expect(save.status).toBe(400);
    expect(save.body.error).toMatch(/tick the box/);
    expect(vault.size).toBe(0);
    expect((await request(appWith()).post("/social-accounts/whatsapp/byok/check").send(CREDS)).status).toBe(200);
  });

  it("an unreadable or oversized body answers a fixed line and never echoes or logs the body", async () => {
    const r = await request(appWith()).post("/social-accounts/whatsapp/byok").set("Content-Type", "application/json").send(`{"systemUserToken":"${TOKEN}",`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/could not be read/);
    const big = await request(appWith()).post("/social-accounts/whatsapp/byok").send({ ...BODY, systemUserToken: "a".repeat(5000) });
    expect(big.status).toBe(400);
    expect(leaks([r.body, big.body, logged])).toBe(false);
  });
});

describe("Meta says no", () => {
  const cases: Array<[string, (url: string) => Response, number, RegExp]> = [
    ["a rejected token", () => new Response(JSON.stringify({ error: { code: 190 } }), { status: 401 }), 400, /did not accept this token/],
    ["a missing permission", () => new Response(JSON.stringify({ error: { code: 10 } }), { status: 403 }), 400, /refused the request/],
    ["a phone number that is not there", () => new Response(JSON.stringify({ error: { code: 100 } }), { status: 400 }), 400, /could not find that phone number/],
    ["throttling", () => new Response("{}", { status: 429 }), 429, /limiting requests/],
    ["an outage", () => new Response("{}", { status: 503 }), 502, /Could not reach Meta/],
  ];
  for (const [label, reply, status, text] of cases) {
    it(`${label} stores nothing and answers a fixed line`, async () => {
      metaReply = reply;
      const r = await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
      expect(r.status).toBe(status);
      expect(r.body.error).toMatch(text);
      expect(vault.size).toBe(0);
      expect(tables.social_accounts).toHaveLength(0);
      expect(leaks([r.body, logged])).toBe(false);
    });
  }

  it("after the daily cap of rejected credentials, further tries are refused without calling Meta", async () => {
    metaReply = () => new Response(JSON.stringify({ error: { code: 190 } }), { status: 401 });
    const a = appWith(registry(), { rateMax: 100 });
    for (let i = 0; i < WHATSAPP_BYOK_FAILED_VALIDATIONS_PER_DAY; i++) expect((await request(a).post("/social-accounts/whatsapp/byok/check").send(CREDS)).status).toBe(400);
    const callsBefore = metaCalls.length;
    const capped = await request(a).post("/social-accounts/whatsapp/byok/check").send(CREDS);
    expect(capped.status).toBe(429);
    expect(metaCalls.length).toBe(callsBefore);
  });
});

describe("the token goes into Supabase Vault and nowhere else", () => {
  it("check proves the credentials and stores NOTHING (no Vault write, no row)", async () => {
    const r = await request(appWith()).post("/social-accounts/whatsapp/byok/check").send(CREDS);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, displayName: "Acme Cafe", keyHint: "****0987" });
    expect(ctx.rpcCalls).not.toContain("store_social_token");
    expect(vault.size).toBe(0);
    expect(tables.social_accounts).toHaveLength(0);
  });

  it("save encrypts the login through store_social_token once, and the row holds only the Vault reference and non-secret ids", async () => {
    const r = await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, displayName: "Acme Cafe", keyHint: "****0987" });

    expect(ctx.rpcCalls.filter((f) => f === "store_social_token")).toHaveLength(1);
    expect(vault.size).toBe(1);
    const [vaultId, stored] = [...vault.entries()][0];
    expect(parseWhatsAppBundle(stored)).toEqual(CREDS.systemUserToken ? { systemUserToken: TOKEN, wabaId: WABA, phoneNumberId: PHONE } : null);

    expect(tables.social_accounts).toHaveLength(1);
    const row = tables.social_accounts[0];
    expect(row).toMatchObject({
      account_id: "acc1",
      platform: "whatsapp",
      platform_account_id: PHONE,
      display_name: "Acme Cafe",
      access_token_vault_id: vaultId, // the existing column, so the 0117 wipe on disconnect covers it
      refresh_token_vault_id: null,
      credential_mode: "byok",
      byok_status: "valid",
      byok_key_hint: "****0987",
      whatsapp_business_account_id: WABA,
      whatsapp_phone_number_id: PHONE,
    });
    // No new secret column exists, and the token is in no column of the row at all.
    expect(Object.keys(row).filter((k) => /system_user|whatsapp_.*token/i.test(k))).toEqual([]);
    expect(leaks(row)).toBe(false);
    expect(leaks([r.body, logged])).toBe(false);
  });

  it("the token reaches Meta only in the Authorization header, on both proof calls", async () => {
    await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
    expect(metaCalls).toHaveLength(2);
    expect(metaAuth).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    for (const url of metaCalls) expect(url).not.toContain(TOKEN);
  });

  it("rotating the token of the same phone number updates the Vault secret in place: one row, one secret", async () => {
    await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
    const NEW = "rotated_fake_system_user_token_value_9876543210";
    const r = await request(appWith()).post("/social-accounts/whatsapp/byok").send({ ...BODY, systemUserToken: NEW });
    expect(r.status).toBe(200);
    expect(ctx.rpcCalls.filter((f) => f === "store_social_token")).toHaveLength(1);
    expect(ctx.rpcCalls).toContain("update_social_token");
    expect(vault.size).toBe(1);
    expect(parseWhatsAppBundle([...vault.values()][0])!.systemUserToken).toBe(NEW);
    expect(tables.social_accounts).toHaveLength(1);
    expect(JSON.stringify([tables.social_accounts, r.body])).not.toContain(NEW);
  });

  it("two accounts connecting the same number keep their own rows and their own Vault secrets", async () => {
    await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
    ctx.account = "acc2";
    setTier("agency", "acc2");
    await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
    expect(tables.social_accounts.map((r) => r.account_id).sort()).toEqual(["acc1", "acc2"]);
    expect(vault.size).toBe(2);
  });

  it("the plain list of connections never selects a token or Vault column", async () => {
    await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
    ctx.selects = [];
    const list = await request(appWith()).get("/social-accounts");
    expect(list.status).toBe(200);
    expect(ctx.selects.length).toBeGreaterThan(0);
    for (const cols of ctx.selects) expect(cols).not.toMatch(/token|vault|secret/i);
    expect(leaks(list.body)).toBe(false);
  });

  it("disconnecting overwrites the stored login (the 0117 wipe), so the token does not survive in Vault", async () => {
    await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
    const id = tables.social_accounts[0].id as string;
    const vaultId = tables.social_accounts[0].access_token_vault_id as string;
    expect(parseWhatsAppBundle(vault.get(vaultId))).not.toBeNull();
    const del = await request(appWith()).delete(`/social-accounts/${id}`);
    expect(del.status).toBe(204);
    expect(vault.get(vaultId)).toBe("revoked");
    expect([...vault.values()].some((v) => leaks(v))).toBe(false);
    expect(tables.social_accounts[0].tokens_wiped_at).toBeTruthy();
  });

  it("the account limit still applies to a new WhatsApp number", async () => {
    setTier("business");
    tables.social_accounts = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, account_id: "acc1", platform: "mastodon", platform_account_id: `m${i}`, disconnected_at: null, connected_at: new Date().toISOString() }));
    const r = await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
    expect(r.status).toBe(403);
    expect(vault.size).toBe(0);
  });
});

describe("migration 0124 (static check of the SQL file)", () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations/0124_whatsapp_byok.sql"), "utf8");
  const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");

  it("adds the two non-secret id columns and NO vault or token column", () => {
    expect(code).toMatch(/add column if not exists whatsapp_business_account_id text/);
    expect(code).toMatch(/add column if not exists whatsapp_phone_number_id text/);
    expect(code).not.toMatch(/whatsapp_system_user_token_vault_id/);
    expect(code).not.toMatch(/add column[^;]*(token|secret|vault)/i);
  });

  it("adds whatsapp to both platform CHECK constraints, keeping every existing platform", () => {
    for (const table of ["oauth_states", "social_accounts"]) {
      const m = new RegExp(`alter table ${table} add constraint ${table}_platform_check\\s+check \\(platform in \\(([^)]*)\\)\\)`).exec(code);
      expect(m, table).not.toBeNull();
      const list = m![1].split(",").map((s) => s.trim().replace(/'/g, ""));
      for (const p of ["meta", "tiktok", "pinterest", "youtube", "mastodon", "bluesky", "telegram", "linkedin", "threads", "facebook", "instagram", "discord", "tumblr", "x", "wordpress", "devto", "hashnode", "lemmy", "slack", "nostr", "whop", "whatsapp"]) {
        expect(list, `${table}: ${p}`).toContain(p);
      }
    }
  });

  it("widens the 0123 'BYOK is X-only' check to X and WhatsApp", () => {
    expect(code).toMatch(/drop constraint if exists social_accounts_byok_x_only_check/);
    expect(code).toMatch(/check \(credential_mode = 'platform' or platform in \('x', 'whatsapp'\)\)/);
  });

  it("a WhatsApp row must carry both ids and the customer's own credentials; other platforms carry neither", () => {
    expect(code).toMatch(/platform = 'whatsapp' and credential_mode = 'byok'/);
    expect(code).toMatch(/whatsapp_business_account_id is not null and whatsapp_phone_number_id is not null/);
    expect(code).toMatch(/\^\[0-9\]\{5,25\}\$/);
  });
});

describe("migration 0125 (database plan gate) and the route's handling of it", () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations/0125_whatsapp_plan_gate_trigger.sql"), "utf8");
  const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
  const listOf = (re: RegExp) => (re.exec(code)?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, "")).sort();

  it("the tier list in the SQL equals WHATSAPP_BYOK_ALLOWED_TIERS in tier.ts", () => {
    expect(code).toMatch(/v_tier in \(([^)]*)\)/);
    expect(listOf(/v_tier in \(([^)]*)\)/)).toEqual([...WHATSAPP_BYOK_ALLOWED_TIERS].sort());
  });

  it("only active and trialing count, as in resolveTier", () => {
    expect(listOf(/v_status in \(([^)]*)\)/)).toEqual(["active", "trialing"]);
  });

  it("is a SECURITY DEFINER trigger function with a pinned search_path, EXECUTE revoked from public, one transaction", () => {
    expect(code).toMatch(/security definer/);
    expect(code).toMatch(/set search_path = public, pg_temp/);
    expect(code).toMatch(/revoke execute on function public\.enforce_whatsapp_plan_gate\(\) from public/);
    expect(code).toMatch(/before insert or update on public\.social_accounts/);
    expect(code).toMatch(/^begin;/m);
    expect(code).toMatch(/^commit;/m);
    expect(sql).toMatch(/-- ROLLBACK/);
  });

  it("raises the distinctive code and message the backend maps", () => {
    expect(code).toContain("'whatsapp requires the Business plan or above'");
    expect(code).toContain("errcode = 'LRWA1'");
    expect(WHATSAPP_DB_GATE_CODE).toBe("LRWA1");
    expect(WHATSAPP_DB_GATE_MESSAGE).toBe("whatsapp requires the Business plan or above");
  });

  it("isWhatsappPlanGateError matches the code or the message, and nothing else", () => {
    expect(isWhatsappPlanGateError({ code: "LRWA1", message: "x" })).toBe(true);
    expect(isWhatsappPlanGateError({ message: "whatsapp requires the Business plan or above" })).toBe(true);
    expect(isWhatsappPlanGateError({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isWhatsappPlanGateError(null)).toBe(false);
  });

  it("when the database trigger refuses the row, the save route answers the fixed HTTP 400 plan message, not a 500, and leaves no secret behind", async () => {
    ctx.dbGateError = { code: "LRWA1", message: WHATSAPP_DB_GATE_MESSAGE };
    const r = await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(WHATSAPP_PLAN_MESSAGE);
    expect(r.body.requiresPlan).toBe("Business");
    expect(tables.social_accounts).toHaveLength(0);
    expect([...vault.values()].some((v) => leaks(v))).toBe(false); // the just-stored login was overwritten
    expect(leaks([r.body, logged])).toBe(false);
  });

  it("any other database error is still a generic 500", async () => {
    ctx.dbGateError = { code: "23505", message: "duplicate key value violates unique constraint" };
    const r = await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
    expect(r.status).toBe(500);
  });
});

describe("the optional App Secret (inbound webhooks): handled exactly like the token", () => {
  const SECRET = "AppSecretNotReal0123456789abcdefAB";
  const OTHER = "OtherSecretNotReal9876543210zyxwvu";
  const stored = () => parseWhatsAppBundle([...vault.values()][0]);

  it("is optional: a login without one still saves, and an old-shape bundle is exactly as before", async () => {
    const r = await request(appWith()).post("/social-accounts/whatsapp/byok").send(BODY);
    expect(r.status).toBe(200);
    expect(JSON.parse([...vault.values()][0])).toEqual({ v: 1, systemUserToken: TOKEN, wabaId: WABA, phoneNumberId: PHONE });
  });

  it("is saved inside the Vault string next to the token, and nowhere else (no column, no response, no log)", async () => {
    const r = await request(appWith()).post("/social-accounts/whatsapp/byok").send({ ...BODY, appSecret: SECRET });
    expect(r.status).toBe(200);
    expect(stored()?.appSecret).toBe(SECRET);
    expect(r.body).toEqual({ ok: true, displayName: "Acme Cafe", keyHint: "****0987" });
    expect(JSON.stringify(tables.social_accounts)).not.toContain(SECRET);
    expect(JSON.stringify([r.body, logged, ctx.selects])).not.toContain(SECRET);
  });

  it("check accepts it, proves the rest, stores nothing and does not echo it", async () => {
    const r = await request(appWith()).post("/social-accounts/whatsapp/byok/check").send({ ...CREDS, appSecret: SECRET });
    expect(r.status).toBe(200);
    expect(vault.size).toBe(0);
    expect(JSON.stringify([r.body, logged])).not.toContain(SECRET);
  });

  it("a blank field counts as not given; a malformed one is refused before Meta or Vault and is never echoed", async () => {
    expect((await request(appWith()).post("/social-accounts/whatsapp/byok/check").send({ ...CREDS, appSecret: "   " })).status).toBe(200);
    for (const bad of ["short", "has spaces in it 0123456789", "a".repeat(80), "quote\"0123456789abcdef", "<script>0123456789ab"]) {
      const r = await request(appWith()).post("/social-accounts/whatsapp/byok").send({ ...BODY, appSecret: bad });
      expect(r.status, bad).toBe(400);
      expect(r.body.error).toMatch(/App Secret/);
      expect(JSON.stringify(r.body)).not.toContain(bad);
    }
    expect(vault.size).toBe(0);
  });

  it("saving a new one overwrites the old; saving without one keeps the secret already on file for that connection", async () => {
    await request(appWith()).post("/social-accounts/whatsapp/byok").send({ ...BODY, appSecret: SECRET });
    await request(appWith()).post("/social-accounts/whatsapp/byok").send({ ...BODY, systemUserToken: TOKEN + "_rotated" });
    expect(vault.size).toBe(1);
    expect(stored()).toMatchObject({ systemUserToken: TOKEN + "_rotated", appSecret: SECRET });
    await request(appWith()).post("/social-accounts/whatsapp/byok").send({ ...BODY, appSecret: OTHER });
    expect(stored()?.appSecret).toBe(OTHER);
  });

  it("a wiped login (disconnect) holds no secret at all", async () => {
    await request(appWith()).post("/social-accounts/whatsapp/byok").send({ ...BODY, appSecret: SECRET });
    const id = tables.social_accounts[0].access_token_vault_id as string;
    const { wipeVaultSecrets } = await import("../../tokenWipe.js");
    const { supabase } = await import("../../supabase.js");
    await wipeVaultSecrets(supabase as never, [id]);
    expect(vault.get(id)).toBe("revoked");
    expect(parseWhatsAppBundle(vault.get(id))).toBeNull();
  });
});
