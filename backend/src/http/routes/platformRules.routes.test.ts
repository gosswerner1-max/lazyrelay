// GET /platforms/rules: all platforms, one platform, or a clear 404. Login is mocked.

import { describe, it, expect, vi } from "vitest";
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
