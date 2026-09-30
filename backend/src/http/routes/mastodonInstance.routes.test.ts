// GET /social-accounts/connect?platform=mastodon&instance=... validates the customer's server and
// hands only a normalised https origin to startConnect. No instance (or mastodon.social) is the
// old flow with no context at all.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

const connect = vi.hoisted(() => ({ calls: [] as Array<{ platform: string; context: string | undefined }>, limit: false }));
vi.mock("../auth.js", () => ({ requireAuth: (r: any, _s: any, n: any) => ((r.accountId = "acct-1"), n()) }));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", () => ({ supabase: { from: () => ({}) } }));
vi.mock("../../accountLimits.js", () => ({ checkAccountLimit: async () => null }));
vi.mock("../../scheduler.js", () => ({ getAccessToken: async () => "t" }));
vi.mock("../../platforms/connect.js", () => ({
  startConnect: async (_a: string, platform: string, _r: unknown, context?: string) => {
    if (connect.limit) {
      const { ConnectLimitError } = await import("../../platforms/mastodonInstanceLimit.js");
      throw new ConnectLimitError("You can try up to 5 different Mastodon servers per day. Try again tomorrow.");
    }
    connect.calls.push({ platform, context });
    return { url: "https://idp.example/authorize", stateId: "st1" };
  },
  completeConnect: async () => ({}),
  getPendingSelection: async () => ({}),
  finalizeConnectSelection: async () => ({}),
  cancelConnectSelection: async () => ({}),
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
  connect.limit = false;
});

describe("connect with an instance", () => {
  it("passes a normalised origin for another server", async () => {
    const r = await request(app()).get("/social-accounts/connect?platform=mastodon&instance=Hachyderm.IO");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ authorizeUrl: "https://idp.example/authorize" });
    expect(connect.calls).toEqual([{ platform: "mastodon", context: "https://hachyderm.io" }]);
  });

  it("accepts a full handle", async () => {
    await request(app()).get(`/social-accounts/connect?platform=mastodon&instance=${encodeURIComponent("@me@hachyderm.io")}`);
    expect(connect.calls).toEqual([{ platform: "mastodon", context: "https://hachyderm.io" }]);
  });

  it("no instance, a blank one, or mastodon.social is the old flow with no context", async () => {
    await request(app()).get("/social-accounts/connect?platform=mastodon");
    await request(app()).get("/social-accounts/connect?platform=mastodon&instance=");
    await request(app()).get("/social-accounts/connect?platform=mastodon&instance=mastodon.social");
    await request(app()).get("/social-accounts/connect?platform=mastodon&instance=https://Mastodon.Social/");
    expect(connect.calls).toEqual([
      { platform: "mastodon", context: undefined },
      { platform: "mastodon", context: undefined },
      { platform: "mastodon", context: undefined },
      { platform: "mastodon", context: undefined },
    ]);
  });

  it("refuses a bad address with a plain message and never starts a connect", async () => {
    for (const bad of ["http://hachyderm.io", "hachyderm.io:8443", "hachyderm.io/web", "10.0.0.5", "a b"]) {
      const r = await request(app()).get(`/social-accounts/connect?platform=mastodon&instance=${encodeURIComponent(bad)}`);
      expect(r.status, bad).toBe(400);
      expect(r.body.error).toEqual(expect.any(String));
      expect(r.body.error).not.toMatch(/[–—]/);
    }
    expect(connect.calls).toHaveLength(0);
  });

  it("answers 429 with the plain message when the daily server limit is hit", async () => {
    connect.limit = true;
    const r = await request(app()).get("/social-accounts/connect?platform=mastodon&instance=hachyderm.io");
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/up to 5 different Mastodon servers/);
  });

  it("the instance is ignored for every other platform", async () => {
    await request(app()).get("/social-accounts/connect?platform=linkedin&instance=hachyderm.io");
    expect(connect.calls).toEqual([{ platform: "linkedin", context: undefined }]);
  });
});
