// /whatsapp broadcast routes: templates (sync from the customer's own Meta account), the customer's rate card, broadcasts (preview,
// schedule, list, cancel) and resuming a paused number. Gate order: WHATSAPP_BYOK_ENABLED, WHATSAPP_BROADCASTS_ENABLED and
// WHATSAPP_SEND_ENABLED all exactly "true", the platform visible for the account, a signed-in HUMAN (an API key is refused on every
// route: there is no API key, MCP or Zapier path to send), then a paid plan. Supabase is the in-memory fake, the Meta HTTP client is
// injected and fake: nothing reaches any network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";
import type { HttpClient } from "../../whatsappBroadcast/cloudApi.js";

const ctx = vi.hoisted(() => ({ account: "acc1", signedIn: true, method: "jwt" as "jwt" | "apiKey", canSee: true }));

vi.mock("../auth.js", async () => {
  const payload = Buffer.from(JSON.stringify({ sub: "33333333-3333-4333-8333-333333333333" })).toString("base64url");
  return {
    requireAuth: (req: any, res: any, next: any) => {
      if (!ctx.signedIn) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      req.accountId = ctx.account;
      req.authMethod = ctx.method;
      req.rawToken = `h.${payload}.s`;
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
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  const k = await import("../../whatsappBroadcast/testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});
vi.mock("./socialAccounts.routes.js", () => ({ canSeePlatform: () => ctx.canSee }));

const { buildWhatsAppBroadcastsRouter } = await import("./whatsappBroadcasts.routes.js");
const kit = await import("../../whatsappBroadcast/testKit.js");
const { ACC, ACC_OTHER, SA, TEMPLATE_ID, TOKEN, seedWorld, resetTables, setTestEnv, addContact } = kit;

const SAVED = { ...process.env };
let calls: Array<{ url: string; auth: string }> = [];
const http: HttpClient = async (url, init) => {
  calls.push({ url, auth: init.headers.Authorization });
  return { status: 200, json: { data: [{ id: "900", name: "welcome_offer", language: "en_US", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Hi {{1}}" }] }] } };
};
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildWhatsAppBroadcastsRouter({ http }));
  return a;
};
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();
const body = (over: Record<string, unknown> = {}) => ({ social_account_id: SA, template_id: TEMPLATE_ID, name: "Spring sale", params: ["Friend", "20%"], scheduled_for: FUTURE(), ...over });
let logged: string[] = [];

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
  ctx.account = ACC;
  ctx.signedIn = true;
  ctx.method = "jwt";
  ctx.canSee = true;
  calls = [];
  addContact("+27821110001");
  addContact("+27821110002");
  logged = [];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

const paths: Array<[string, string, () => request.Test]> = [
  ["GET", "/whatsapp/templates", () => request(app()).get(`/whatsapp/templates?social_account_id=${SA}`)],
  ["POST", "/whatsapp/templates/sync", () => request(app()).post("/whatsapp/templates/sync").send({ social_account_id: SA })],
  ["GET", "/whatsapp/rate-card", () => request(app()).get(`/whatsapp/rate-card?social_account_id=${SA}`)],
  ["PUT", "/whatsapp/rate-card", () => request(app()).put("/whatsapp/rate-card").send({ social_account_id: SA, currency: "USD", marketing: 0.05, utility: 0.01, authentication: 0.01 })],
  ["GET", "/whatsapp/broadcasts", () => request(app()).get("/whatsapp/broadcasts")],
  ["POST", "/whatsapp/broadcasts", () => request(app()).post("/whatsapp/broadcasts").send(body())],
  ["GET", "/whatsapp/broadcasts/:id", () => request(app()).get("/whatsapp/broadcasts/44444444-4444-4444-8444-444444444444")],
  ["POST", "/whatsapp/broadcasts/:id/cancel", () => request(app()).post("/whatsapp/broadcasts/44444444-4444-4444-8444-444444444444/cancel").send({})],
  ["POST", "/whatsapp/connections/:id/resume-sending", () => request(app()).post(`/whatsapp/connections/${SA}/resume-sending`).send({})],
];

describe("gating", () => {
  it.each(paths)("%s %s is a 404 while any of the three flags is off", async (_m, _p, call) => {
    for (const name of ["WHATSAPP_BYOK_ENABLED", "WHATSAPP_BROADCASTS_ENABLED", "WHATSAPP_SEND_ENABLED"]) {
      process.env[name] = "false";
      expect((await call()).status).toBe(404);
      process.env[name] = "true";
    }
    delete process.env.WHATSAPP_SEND_ENABLED;
    expect((await call()).status).toBe(404);
  });

  it.each(paths)("%s %s is a 404 when the platform is not visible for the account", async (_m, _p, call) => {
    ctx.canSee = false;
    expect((await call()).status).toBe(404);
  });

  it.each(paths)("%s %s needs a sign-in", async (_m, _p, call) => {
    ctx.signedIn = false;
    expect((await call()).status).toBe(401);
  });

  it.each(paths)("%s %s REFUSES an API key: there is no API key path to send", async (_m, _p, call) => {
    ctx.method = "apiKey";
    expect((await call()).status).toBe(403);
  });

  it.each(paths)("%s %s is refused below the paid plan", async (_m, _p, call) => {
    tables.subscriptions = [];
    const res = await call();
    expect(res.status).toBe(400);
    expect(res.body.requiresPlan).toBeTruthy();
  });
});

describe("GET /whatsapp/send-capabilities", () => {
  const get = () => request(app()).get("/whatsapp/send-capabilities");
  it("says sending is available when the flags, visibility, contact keys and plan all pass, and that is ALL it checks (no cap, no kill switch)", async () => {
    expect((await get()).body).toEqual({ sending: true });
  });
  it("is false (never an error) with the send flag off, on a free plan, or without the contact keys", async () => {
    process.env.WHATSAPP_SEND_ENABLED = "false";
    expect((await get()).body).toEqual({ sending: false });
    process.env.WHATSAPP_SEND_ENABLED = "true";
    tables.subscriptions = [];
    expect((await get()).body.sending).toBe(false);
    tables.subscriptions = [{ account_id: ACC, tier: "business", status: "active" }];
    delete process.env.WHATSAPP_CONTACT_ENC_KEY;
    expect((await get()).body.sending).toBe(false);
  });
  it("needs a sign-in and answers false for an API key too (it reveals nothing else)", async () => {
    ctx.signedIn = false;
    expect((await get()).status).toBe(401);
  });
});

describe("templates", () => {
  it("sync reads the customer's templates from THEIR Meta account with THEIR token, and the list shows what can be used", async () => {
    const sync = await request(app()).post("/whatsapp/templates/sync").send({ social_account_id: SA });
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ synced: 1, approved: 1 });
    expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
    const list = await request(app()).get(`/whatsapp/templates?social_account_id=${SA}`);
    expect(list.body.templates.map((t: any) => [t.name, t.usable])).toEqual(expect.arrayContaining([["welcome_offer", true]]));
    expect(JSON.stringify(list.body)).not.toContain(TOKEN);
  });

  it("sync for a connection that is not the account's is a 404 and calls nobody", async () => {
    const res = await request(app()).post("/whatsapp/templates/sync").send({ social_account_id: "22222222-2222-4222-8222-222222222222" });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("a bad id is a 400", async () => {
    expect((await request(app()).get("/whatsapp/templates?social_account_id=nope")).status).toBe(400);
  });
});

describe("rate card (the customer's own prices, used only for an ESTIMATE)", () => {
  const put = (over: Record<string, unknown> = {}) => request(app()).put("/whatsapp/rate-card").send({ social_account_id: SA, currency: "USD", marketing: 0.05, utility: 0.01, authentication: 0.01, ...over });
  it("saves and reads back, replacing in place", async () => {
    expect((await put()).status).toBe(200);
    expect((await put({ marketing: 0.07 })).status).toBe(200);
    expect(tables.whatsapp_rate_cards).toHaveLength(1);
    const got = await request(app()).get(`/whatsapp/rate-card?social_account_id=${SA}`);
    expect(got.body).toEqual({ rateCard: { currency: "USD", marketing: 0.07, utility: 0.01, authentication: 0.01 } });
  });
  it("is null before one is saved", async () => {
    expect((await request(app()).get(`/whatsapp/rate-card?social_account_id=${SA}`)).body).toEqual({ rateCard: null });
  });
  it.each([{ currency: "usd" }, { currency: "US" }, { marketing: -1 }, { utility: 5000 }, { authentication: "x" }])("rejects %j", async (over) => {
    expect((await put(over)).status).toBe(400);
  });
  it("another account's connection is a 404", async () => {
    expect((await put({ social_account_id: "22222222-2222-4222-8222-222222222222" })).status).toBe(404);
  });
});

describe("broadcasts", () => {
  it("dryRun previews the audience and cost estimate and stores nothing", async () => {
    tables.whatsapp_rate_cards = [{ account_id: ACC, social_account_id: SA, currency: "USD", marketing_per_message: 0.05, utility_per_message: 0, authentication_per_message: 0 }];
    const res = await request(app()).post("/whatsapp/broadcasts").send(body({ dry_run: true }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, preview: { audience: 2, excludedUs: 0, estimatedCost: { amount: 0.1, currency: "USD", isEstimate: true } } });
    expect(tables.whatsapp_broadcasts).toHaveLength(0);
  });

  it("schedules a broadcast: 201, the view, who scheduled it, and no number anywhere", async () => {
    const res = await request(app()).post("/whatsapp/broadcasts").send(body());
    expect(res.status).toBe(201);
    expect(res.body.broadcast).toMatchObject({ name: "Spring sale", status: "scheduled", templateName: "spring_offer", delivery: { delivered: 0, ofAccepted: 0 } });
    expect(tables.whatsapp_broadcasts[0].created_by).toBe("33333333-3333-4333-8333-333333333333");
    expect(JSON.stringify(res.body)).not.toMatch(/27821110/);
  });

  it.each([
    ["a pending template", () => void (tables.whatsapp_message_templates[0].status = "pending"), {}, 400, "template_unusable"],
    ["a missing own login", () => void (tables.social_accounts[0].access_token_vault_id = null), {}, 409, "no_own_credentials"],
    ["a paused number", () => void (tables.whatsapp_connection_send_state = [{ social_account_id: SA, account_id: ACC, paused_at: new Date().toISOString(), pause_reason: "quality" }]), {}, 409, "connection_paused"],
    ["the wrong variable count", () => {}, { params: ["only one"] }, 400, "params_mismatch"],
    ["a time in the past", () => {}, { scheduled_for: new Date(Date.now() - 1000).toISOString() }, 400, "schedule_invalid"],
  ])("refuses %s with a stable code", async (_l, arrange, over, status, code) => {
    arrange();
    const res = await request(app()).post("/whatsapp/broadcasts").send(body(over));
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(tables.whatsapp_broadcasts).toHaveLength(0);
  });

  it("rejects a malformed body (400) and never trusts an account id sent by the client", async () => {
    expect((await request(app()).post("/whatsapp/broadcasts").send({ ...body(), template_id: "nope" })).status).toBe(400);
    expect((await request(app()).post("/whatsapp/broadcasts").send({ ...body(), scheduled_for: "tomorrow-ish" })).status).toBe(400);
    expect((await request(app()).post("/whatsapp/broadcasts").send({ ...body(), params: "x" })).status).toBe(400);
    const res = await request(app()).post("/whatsapp/broadcasts").send({ ...body(), account_id: "acc2" });
    expect(res.status).toBe(201);
    expect(tables.whatsapp_broadcasts[0].account_id).toBe(ACC);
  });

  it("lists and reads only this account's broadcasts; another account's is a 404", async () => {
    const created = await request(app()).post("/whatsapp/broadcasts").send(body());
    const id = created.body.broadcast.id;
    tables.whatsapp_broadcasts.push({ ...tables.whatsapp_broadcasts[0], id: "55555555-5555-4555-8555-555555555555", account_id: ACC_OTHER });
    const list = await request(app()).get("/whatsapp/broadcasts");
    expect(list.body.broadcasts.map((b: any) => b.id)).toEqual([id]);
    expect((await request(app()).get(`/whatsapp/broadcasts/${id}`)).status).toBe(200);
    expect((await request(app()).get("/whatsapp/broadcasts/55555555-5555-4555-8555-555555555555")).status).toBe(404);
  });

  it("cancels (200), then refuses a second cancel (409), and a stranger's id is a 404", async () => {
    const id = (await request(app()).post("/whatsapp/broadcasts").send(body())).body.broadcast.id;
    expect((await request(app()).post(`/whatsapp/broadcasts/${id}/cancel`).send({})).status).toBe(200);
    expect((await request(app()).post(`/whatsapp/broadcasts/${id}/cancel`).send({})).status).toBe(409);
    expect((await request(app()).post("/whatsapp/broadcasts/66666666-6666-4666-8666-666666666666/cancel").send({})).status).toBe(404);
    expect((await request(app()).post("/whatsapp/broadcasts/not-a-uuid/cancel").send({})).status).toBe(400);
  });
});

describe("resume sending", () => {
  it("clears a pause the customer chooses to lift (404 when not paused or not theirs)", async () => {
    expect((await request(app()).post(`/whatsapp/connections/${SA}/resume-sending`).send({})).status).toBe(404);
    tables.whatsapp_connection_send_state = [{ social_account_id: SA, account_id: ACC, paused_at: new Date().toISOString(), pause_reason: "quality" }];
    ctx.account = ACC_OTHER;
    tables.subscriptions.push({ account_id: ACC_OTHER, tier: "business", status: "active" });
    expect((await request(app()).post(`/whatsapp/connections/${SA}/resume-sending`).send({})).status).toBe(404);
    ctx.account = ACC;
    expect((await request(app()).post(`/whatsapp/connections/${SA}/resume-sending`).send({})).status).toBe(200);
    expect(tables.whatsapp_connection_send_state[0].paused_at).toBeNull();
  });
});

describe("privacy", () => {
  it("logs no number, token or template variable", async () => {
    await request(app()).post("/whatsapp/templates/sync").send({ social_account_id: SA });
    await request(app()).post("/whatsapp/broadcasts").send(body({ params: ["Secret Friend", "20%"] }));
    const all = logged.join("\n");
    expect(all).not.toMatch(/27821110|Secret Friend/);
    expect(all).not.toContain(TOKEN);
  });
});
