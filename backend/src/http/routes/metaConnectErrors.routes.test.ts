// What a customer sees when Meta rejects a Facebook or Instagram connect: ONE fixed friendly sentence, never Meta's own error
// text (which can echo a token). The raw text goes to the server log only, with secrets scrubbed. Runs the real router, the real
// connect flow and the real adapters against a stubbed fetch and the in-memory supabase.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { tables, vault } from "../../testFakeSupabase.js";

vi.mock("../auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.accountId = "acc1";
    req.authMethod = "jwt";
    next();
  },
}));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => f.fakeRpc(fn, args) } };
});
vi.mock("../../accountLimits.js", () => ({ checkAccountLimit: async () => null, checkNewDistinctAccountLimit: async () => null }));
vi.mock("../../scheduler.js", () => ({ getAccessToken: async () => "t" }));
vi.mock("../../http/metaWebhook.js", () => ({ subscribePageToMessaging: vi.fn(async () => {}) }));

const { buildSocialAccountsRouter } = await import("./socialAccounts.routes.js");
const { FacebookAdapter } = await import("../../platforms/facebook.js");
const { InstagramAdapter } = await import("../../platforms/instagram.js");

const FRIENDLY = "We could not finish connecting that account. Please try again, and contact support if it keeps happening.";
const FAKE_TOKEN = "EAAFakeMetaTokenForTests0123456789abcdefXYZ";
const RAW = `Invalid OAuth access token ${FAKE_TOKEN} (code 190)`;
const FRONTEND = process.env.FRONTEND_URL ?? "http://localhost:5173";

const registry = () => new Map<string, unknown>([["facebook", new FacebookAdapter("cid", "csecret-value-123", "https://x.example/cb")], ["instagram", new InstagramAdapter("cid", "csecret-value-123", "https://x.example/cb")]]) as never;
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use(buildSocialAccountsRouter(registry()));
  return a;
};
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();

let logged: unknown[][];
/** Graph answers: the code exchange works (handing back FAKE_TOKEN), then whichever later call is `failAt` fails with RAW. */
function stubGraph(failAt: "code" | "longlived" | "pages") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const body = String(init?.body ?? "");
      const isToken = u.includes("/oauth/access_token");
      const isLong = isToken && (u.includes("fb_exchange_token") || body.includes("fb_exchange_token"));
      const fail = () => new Response(JSON.stringify({ error: { message: RAW } }), { status: 400 });
      if (isToken && !isLong) return failAt === "code" ? fail() : new Response(JSON.stringify({ access_token: FAKE_TOKEN }), { status: 200 });
      if (isLong) return failAt === "longlived" ? fail() : new Response(JSON.stringify({ access_token: FAKE_TOKEN + "LONG" }), { status: 200 });
      if (u.includes("/me/accounts")) return failAt === "pages" ? fail() : new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }),
  );
}
const logText = () => JSON.stringify(logged);

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a));
  vi.spyOn(console, "log").mockImplementation((...a) => void logged.push(a));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

for (const platform of ["facebook", "instagram"] as const) {
  for (const failAt of ["code", "longlived", "pages"] as const) {
    describe(`${platform} callback, Meta fails at the ${failAt} step`, () => {
      beforeEach(() => {
        tables.oauth_states = [{ id: "st1", account_id: "acc1", platform, expires_at: future(), pkce_verifier: null, pending_options: null, pending_token_vault_id: null }];
        stubGraph(failAt);
      });

      it("the redirect carries only the fixed friendly sentence, status unchanged", async () => {
        const r = await request(app()).get("/social-accounts/callback?code=thecode&state=st1").set("Cookie", "lr_oauth_state=st1");
        expect(r.status).toBe(302);
        const location = String(r.headers.location);
        expect(location).toBe(`${FRONTEND}/?connectError=${encodeURIComponent(FRIENDLY)}`);
        expect(decodeURIComponent(location)).not.toContain(FAKE_TOKEN);
        expect(decodeURIComponent(location)).not.toContain("Invalid OAuth");
      });

      it("the JSON answer is 400 with the fixed friendly sentence only", async () => {
        const r = await request(app()).get("/social-accounts/callback?code=thecode&state=st1&format=json").set("Cookie", "lr_oauth_state=st1");
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ error: FRIENDLY });
        expect(r.text).not.toContain(FAKE_TOKEN);
      });

      it("the raw Meta text reaches the server log, with the token scrubbed out", async () => {
        await request(app()).get("/social-accounts/callback?code=thecode&state=st1&format=json").set("Cookie", "lr_oauth_state=st1");
        expect(logText()).toContain("Invalid OAuth access token");
        expect(logText()).toContain("[removed]");
        expect(logText()).not.toContain(FAKE_TOKEN);
        expect(logText()).not.toContain("csecret-value-123");
      });
    });
  }
}

describe("finalize-selection when Meta fails while re-listing the Pages", () => {
  it("answers 400 with the fixed friendly sentence and logs the scrubbed raw text", async () => {
    tables.oauth_states = [{ id: "st2", account_id: "acc1", platform: "facebook", expires_at: future(), pending_options: [{ id: "p1", name: "P" }], pending_token_vault_id: "v1" }];
    vault.set("v1", FAKE_TOKEN);
    stubGraph("pages");
    const r = await request(app()).post("/social-accounts/finalize-selection").send({ token: "st2", selectedIds: ["p1"] });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: FRIENDLY });
    expect(r.text).not.toContain(FAKE_TOKEN);
    expect(logText()).toContain("Invalid OAuth access token");
    expect(logText()).not.toContain(FAKE_TOKEN);
  });
});

describe("our own plain messages still pass through", () => {
  it("an expired connect link keeps its own wording", async () => {
    tables.oauth_states = [{ id: "st3", account_id: "acc1", platform: "facebook", expires_at: new Date(Date.now() - 1000).toISOString() }];
    const r = await request(app()).get("/social-accounts/callback?code=c&state=st3&format=json").set("Cookie", "lr_oauth_state=st3");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Connect link expired/);
  });
});
