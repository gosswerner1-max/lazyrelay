// GET /platforms/rules: all platforms, one platform, or a clear 404. Login is mocked.

import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.accountId = "acc1";
    next();
  },
}));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});

const { buildSocialAccountsRouter } = await import("./socialAccounts.routes.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildSocialAccountsRouter(new Map() as never));
  return a;
};

describe("GET /platforms/rules", () => {
  it("returns every platform", async () => {
    const r = await request(app()).get("/platforms/rules");
    expect(r.status).toBe(200);
    expect(r.body.platforms.map((p: { platform: string }) => p.platform)).toEqual(expect.arrayContaining(["instagram", "tiktok", "pinterest", "youtube", "bluesky"]));
  });
  it("returns one platform, case-insensitively, with what an agent must send", async () => {
    const r = await request(app()).get("/platforms/rules?platform=TikTok");
    expect(r.body.platforms).toHaveLength(1);
    expect(r.body.platforms[0].required).toContain("tiktokPrivacyLevel");
    expect(r.body.platforms[0].lookups).toContain("get_tiktok_creator_info");
  });
  it("an unknown platform is a 404 that lists the real ones", async () => {
    const r = await request(app()).get("/platforms/rules?platform=myspace");
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/Known platforms: .*instagram/);
  });
});

describe("GET /platforms (the picker)", () => {
  const four = ["wordpress", "devto", "hashnode", "lemmy"];
  const names = (body: unknown) => (body as Array<{ platform: string }>).map((p) => p.platform);
  const withRegistry = (entries: string[]) => {
    const a = express();
    a.use(express.json());
    a.use(buildSocialAccountsRouter(new Map(entries.map((e) => [e, {}])) as never));
    return a;
  };

  it("leaves the four article platforms out while they are not configured", async () => {
    const r = await request(app()).get("/platforms");
    for (const p of four) expect(names(r.body)).not.toContain(p);
    expect(names(r.body)).toContain("tiktok");
  });

  it("configured but not yet proven: only the named test accounts see them", async () => {
    process.env.ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS = "someone-else";
    let r = await request(withRegistry(["devto"])).get("/platforms");
    expect(names(r.body)).not.toContain("devto");
    process.env.ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS = "x, acc1";
    r = await request(withRegistry(["devto", "lemmy"])).get("/platforms");
    expect(names(r.body)).toContain("devto");
    expect(names(r.body)).toContain("lemmy");
    expect(names(r.body)).not.toContain("wordpress");
    expect((r.body as Array<{ platform: string; configured: boolean }>).find((p) => p.platform === "devto")?.configured).toBe(true);
    process.env.ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS = "someone-else";
    const blocked = await request(withRegistry(["devto"])).get("/social-accounts/connect?platform=wordpress");
    expect(blocked.status).toBe(400);
    delete process.env.ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS;
  });

  it("once proven, ARTICLE_PLATFORMS_PUBLIC opens them to everyone", async () => {
    process.env.ARTICLE_PLATFORMS_PUBLIC = "true";
    const r = await request(withRegistry(["hashnode"])).get("/platforms");
    expect(names(r.body)).toContain("hashnode");
    delete process.env.ARTICLE_PLATFORMS_PUBLIC;
  });
});

describe("Slack is dormant until it is switched on", () => {
  const names = (body: unknown) => (body as Array<{ platform: string }>).map((p) => p.platform);
  const withRegistry = (entries: string[]) => {
    const a = express();
    a.use(express.json());
    a.use(buildSocialAccountsRouter(new Map(entries.map((e) => [e, {}])) as never));
    return a;
  };
  afterEach(() => {
    for (const k of ["SLACK_PLATFORM_PUBLIC", "SLACK_TEST_ACCOUNT_IDS", "ARTICLE_PLATFORMS_PUBLIC", "ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS"]) delete process.env[k];
  });

  it("is not listed when it is not configured at all, and the connect route refuses it", async () => {
    const r = await request(app()).get("/platforms");
    expect(names(r.body)).not.toContain("slack");
    const c = await request(app()).get("/social-accounts/connect?platform=slack");
    expect(c.status).toBe(400);
    expect(c.body.error).toMatch(/isn't available to connect yet/);
  });

  it("is still hidden and refused when configured but not switched on", async () => {
    const r = await request(withRegistry(["slack", "tiktok"])).get("/platforms");
    expect(names(r.body)).not.toContain("slack");
    expect(names(r.body)).toContain("tiktok"); // everything else is unchanged
    const c = await request(withRegistry(["slack"])).get("/social-accounts/connect?platform=slack");
    expect(c.status).toBe(400);
    expect(c.body.error).toMatch(/isn't available to connect yet/);
  });

  it("the article-platform switches do not open Slack", async () => {
    process.env.ARTICLE_PLATFORMS_PUBLIC = "true";
    process.env.ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS = "acc1";
    const r = await request(withRegistry(["slack", "devto"])).get("/platforms");
    expect(names(r.body)).toContain("devto");
    expect(names(r.body)).not.toContain("slack");
  });

  it("a named test account sees it once it is configured, others do not", async () => {
    process.env.SLACK_TEST_ACCOUNT_IDS = "someone-else";
    expect(names((await request(withRegistry(["slack"])).get("/platforms")).body)).not.toContain("slack");
    process.env.SLACK_TEST_ACCOUNT_IDS = "x, acc1";
    const r = await request(withRegistry(["slack"])).get("/platforms");
    expect(names(r.body)).toContain("slack");
    expect((r.body as Array<{ platform: string; configured: boolean }>).find((p) => p.platform === "slack")?.configured).toBe(true);
    // Even a listed tester sees nothing while the adapter does not exist.
    expect(names((await request(app()).get("/platforms")).body)).not.toContain("slack");
  });

  it("SLACK_PLATFORM_PUBLIC opens it to everyone, but only when configured", async () => {
    process.env.SLACK_PLATFORM_PUBLIC = "true";
    expect(names((await request(withRegistry(["slack"])).get("/platforms")).body)).toContain("slack");
    expect(names((await request(app()).get("/platforms")).body)).not.toContain("slack");
  });

  it("is in the rules lookup with the 4,000 character limit and no media", async () => {
    const r = await request(app()).get("/platforms/rules?platform=slack");
    expect(r.status).toBe(200);
    expect(r.body.platforms[0]).toMatchObject({ platform: "slack", text: { maxLength: 4000 }, media: { textOnlyAllowed: true, image: { supported: false }, video: { supported: false } } });
  });
});
