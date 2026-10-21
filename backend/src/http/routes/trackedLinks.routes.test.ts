// Tracked-link creation and the Campaign clicks summary. Login is mocked; supabase is an in-memory fake plus a recording rpc.
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

const auth = vi.hoisted(() => ({ accountId: "acc1" }));
const rpc = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown>]>, result: { data: [] as unknown, error: null as unknown } }));
vi.mock("../auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.accountId = auth.accountId;
    next();
  },
}));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => f.makeBuilder(t),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpc.calls.push([name, args]);
        return rpc.result;
      },
    },
  };
});

const { buildTrackedLinksRouter } = await import("./trackedLinks.routes.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildTrackedLinksRouter());
  return a;
};

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  rpc.calls = [];
  rpc.result = { data: [], error: null };
  auth.accountId = "acc1";
  delete process.env.LINK_CLICK_UNIQUE_SALT;
});

const create = (body: Record<string, unknown>) => request(app()).post("/tracked-links").send(body);

describe("POST /tracked-links", () => {
  it("creates a link for the signed-in account and returns the public address", async () => {
    tables.scheduled_posts = [{ id: "p1", account_id: "acc1" }];
    const res = await create({ destinationUrl: "https://lazyrelay.com/pricing", platform: "pinterest", scheduledPostId: "p1" });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(res.body.url).toMatch(/\/r\/[A-Za-z0-9_-]{8}$/);
    expect(res.body.destinationUrl).toBe("https://lazyrelay.com/pricing");
    expect(tables.tracked_links).toHaveLength(1);
    expect(tables.tracked_links[0]).toMatchObject({ account_id: "acc1", scheduled_post_id: "p1", platform: "pinterest", destination_url: "https://lazyrelay.com/pricing" });
  });
  it("works without a dispatch", async () => {
    const res = await create({ destinationUrl: "https://timeajob.com/guides", platform: "instagram" });
    expect(res.status).toBe(201);
    expect(tables.tracked_links[0].scheduled_post_id ?? null).toBeNull();
  });
  it("refuses a destination that is not lazyrelay.com or timeajob.com, and stores nothing", async () => {
    for (const bad of ["https://evil.com/", "http://lazyrelay.com/", "https://lazyrelay.com.evil.com/", "javascript:alert(1)", "", 5]) {
      const res = await create({ destinationUrl: bad, platform: "pinterest" });
      expect(res.status, String(bad)).toBe(400);
    }
    expect(tables.tracked_links ?? []).toHaveLength(0);
  });
  it("refuses a missing or malformed platform", async () => {
    for (const bad of [undefined, "", "Pinter est", "x", "a".repeat(31), 5]) {
      expect((await create({ destinationUrl: "https://lazyrelay.com/", platform: bad })).status).toBe(400);
    }
  });
  it("will not attach a link to another account's dispatch", async () => {
    tables.scheduled_posts = [{ id: "p2", account_id: "someone-else" }];
    const res = await create({ destinationUrl: "https://lazyrelay.com/", platform: "pinterest", scheduledPostId: "p2" });
    expect(res.status).toBe(404);
    expect(tables.tracked_links ?? []).toHaveLength(0);
  });
});

describe("GET /analytics/link-clicks", () => {
  const row = { code: "abCD1234", destination_url: "https://lazyrelay.com/pricing", platform: "pinterest", brand: "LazyRelay", scheduled_post_id: "p1", created_at: "2026-10-01T10:00:00Z", clicks: 12, last_click: "2026-10-20T10:00:00Z" };
  it("takes the account from the session, never from the request", async () => {
    await request(app()).get("/analytics/link-clicks?accountId=someone-else&account_id=someone-else");
    expect(rpc.calls[0][0]).toBe("link_clicks_summary");
    expect(rpc.calls[0][1].p_account_id).toBe("acc1");
  });
  it("passes the channel and brand filters, and a window clamped to 1..90 days", async () => {
    await request(app()).get("/analytics/link-clicks?days=500&platform=pinterest&brand=LazyRelay");
    const args = rpc.calls[0][1];
    expect(args.p_platform).toBe("pinterest");
    expect(args.p_brand).toBe("LazyRelay");
    const days = (Date.now() - new Date(args.p_since as string).getTime()) / 86400000;
    expect(Math.round(days)).toBe(90);
    rpc.calls = [];
    await request(app()).get("/analytics/link-clicks");
    expect(Math.round((Date.now() - new Date(rpc.calls[0][1].p_since as string).getTime()) / 86400000)).toBe(30);
    expect(rpc.calls[0][1].p_platform).toBeNull();
    expect(rpc.calls[0][1].p_brand).toBeNull();
  });
  it("refuses a malformed platform without calling the database", async () => {
    const res = await request(app()).get("/analytics/link-clicks?platform=" + encodeURIComponent("x;drop"));
    expect(res.status).toBe(400);
    expect(rpc.calls).toHaveLength(0);
  });
  it("returns tidy links and totals, and says whether unique counting is on", async () => {
    rpc.result = { data: [row, { ...row, code: "zzzz9999", clicks: 3 }], error: null };
    const res = await request(app()).get("/analytics/link-clicks");
    expect(res.status).toBe(200);
    expect(res.body.links[0]).toMatchObject({ code: "abCD1234", destinationUrl: "https://lazyrelay.com/pricing", platform: "pinterest", brand: "LazyRelay", clicks: 12 });
    expect(res.body.links[0]).not.toHaveProperty("uniqueClicks");
    expect(res.body.totals).toEqual({ clicks: 15 });
    expect(res.body).not.toHaveProperty("uniqueTracking");
  });
  it("answers an empty list when nothing is tracked yet", async () => {
    const res = await request(app()).get("/analytics/link-clicks");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ links: [], totals: { clicks: 0 } });
  });
  it("hides a database failure behind a plain 500", async () => {
    rpc.result = { data: null, error: { message: "secret detail" } };
    const res = await request(app()).get("/analytics/link-clicks");
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
  });
});
