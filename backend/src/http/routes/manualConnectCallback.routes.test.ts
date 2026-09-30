// The connect-page callback for the credential-paste platforms (Bluesky, Telegram, Discord, WordPress,
// dev.to, Hashnode, Lemmy) takes the pasted secret in a POST body, so it never appears in the address or in
// request logs. The old GET still works for real OAuth redirects.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

const connect = vi.hoisted(() => ({ calls: [] as Array<{ state: string; code: string }>, fail: null as string | null }));
vi.mock("../auth.js", () => ({ requireAuth: (_r: any, _s: any, n: any) => n() }));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", () => ({ supabase: { from: () => ({}) } }));
vi.mock("../../accountLimits.js", () => ({ checkAccountLimit: async () => null }));
vi.mock("../../scheduler.js", () => ({ getAccessToken: async () => "t" }));
vi.mock("../../platforms/connect.js", () => ({
  startConnect: async () => ({}),
  getPendingSelection: async () => ({}),
  finalizeConnectSelection: async () => ({}),
  cancelConnectSelection: async () => ({}),
  completeConnect: async (state: string, code: string) => {
    connect.calls.push({ state, code });
    if (connect.fail) throw new Error(connect.fail);
    return { status: "connected", socialAccountId: "acct-1" };
  },
}));

const { buildSocialAccountsRouter } = await import("./socialAccounts.routes.js");

const app = () => {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use(buildSocialAccountsRouter(new Map() as never));
  return a;
};

beforeEach(() => {
  connect.calls = [];
  connect.fail = null;
});

describe("POST /social-accounts/callback", () => {
  it("connects with the credential in the body and answers JSON", async () => {
    const r = await request(app()).post("/social-accounts/callback").set("Cookie", "lr_oauth_state=st1").send({ code: '{"apiKey":"k"}', state: "st1" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ connected: true, socialAccountId: "acct-1" });
    expect(connect.calls).toEqual([{ state: "st1", code: '{"apiKey":"k"}' }]);
  });

  it("refuses a browser that did not start the flow", async () => {
    const r = await request(app()).post("/social-accounts/callback").set("Cookie", "lr_oauth_state=other").send({ code: "c", state: "st1" });
    expect(r.status).toBe(403);
    expect(connect.calls).toHaveLength(0);
  });

  it("refuses a body with no code or state, and reports a failed connect as JSON", async () => {
    expect((await request(app()).post("/social-accounts/callback").send({})).status).toBe(400);
    connect.fail = "That did not work";
    const r = await request(app()).post("/social-accounts/callback").set("Cookie", "lr_oauth_state=s").send({ code: "c", state: "s" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "That did not work" });
  });
});

describe("GET /social-accounts/callback (real OAuth redirects)", () => {
  it("still redirects a normal OAuth return, and answers JSON only with format=json", async () => {
    const redirect = await request(app()).get("/social-accounts/callback?code=c&state=s").set("Cookie", "lr_oauth_state=s");
    expect(redirect.status).toBe(302);
    const json = await request(app()).get("/social-accounts/callback?code=c&state=s&format=json").set("Cookie", "lr_oauth_state=s");
    expect(json.body).toEqual({ connected: true, socialAccountId: "acct-1" });
  });
});
