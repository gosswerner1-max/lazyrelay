// GET /mentions end to end through the real router: the optional ?platforms= list,
// the limit applied after it, the "Coming soon" counts, and no change without it.
// Login, rate limit, the comment cache and the AI triage are fakes; no database or
// network is reachable from here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { makeMentionsFakeDb, crowdedAccount, type FakeCall } from "../../testMentionsFakeDb.js";

let current: { db: unknown; calls: FakeCall[] };
const cacheRows = new Map<string, { scheduled_post_id: string; platform_comment_id: string; author: string; text: string; url: string | null; comment_created_at: string }[]>();

vi.mock("../auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.accountId = "acc1";
    req.db = current.db;
    next();
  },
  requireHumanAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../commentTriage.js", () => ({ triageItems: async () => new Map() }));
vi.mock("../../supabase.js", () => ({
  supabase: {
    // mention_comments_cache read and notification_view_state write only.
    from: (table: string) => {
      const b: any = {};
      let ids: string[] = [];
      b.select = () => b;
      b.in = (_c: string, v: string[]) => ((ids = v), b);
      b.order = () => b;
      b.upsert = () => Promise.resolve({ data: null, error: null });
      b.then = (resolve: any, reject: any) =>
        Promise.resolve({ data: table === "mention_comments_cache" ? ids.flatMap((id) => cacheRows.get(id) ?? []) : [], error: null }).then(resolve, reject);
      return b;
    },
  },
}));

const { buildInboxRouter } = await import("./inbox.routes.js");

// Every platform in these tests can read comments; only Mastodon and Bluesky can reply.
const registry = {
  get: (platform: string) => ({ getComments: async () => ({ comments: [], errorMessage: null }), ...(["mastodon", "bluesky"].includes(platform) ? { replyToComment: async () => ({ success: true }) } : {}) }),
} as never;
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildInboxRouter(registry));
  return a;
};

beforeEach(() => {
  cacheRows.clear();
  current = makeMentionsFakeDb(crowdedAccount());
});

describe("GET /mentions?platforms=...", () => {
  it("shows the dev.to and Hashnode posts although 20 newer Facebook posts exist", async () => {
    const r = await request(app()).get("/mentions?platforms=devto,hashnode,mastodon,bluesky,youtube");
    expect(r.status).toBe(200);
    expect(r.body.posts.map((p: any) => p.postId)).toEqual(["dev1", "dev2", "hn1"]);
    expect(r.body.posts.every((p: any) => p.supported === true && p.canReply === false)).toBe(true);
  });

  it("reports the left-out platforms for the 'Coming soon' rows", async () => {
    const r = await request(app()).get("/mentions?platforms=devto,hashnode,mastodon,bluesky,youtube");
    expect(r.body.otherPlatforms).toEqual([{ platform: "facebook", count: 20 }]);
  });

  it("carries the cached comments of the posts it returns, and none from the left-out platforms", async () => {
    cacheRows.set("dev1", [{ scheduled_post_id: "dev1", platform_comment_id: "c1", author: "Maria", text: "Great write-up", url: null, comment_created_at: "2026-10-04T10:00:00Z" }]);
    cacheRows.set("fb0", [{ scheduled_post_id: "fb0", platform_comment_id: "c2", author: "Tom", text: "Nice", url: null, comment_created_at: "2026-10-04T10:00:00Z" }]);
    const r = await request(app()).get("/mentions?platforms=devto,hashnode");
    const dev1 = r.body.posts.find((p: any) => p.postId === "dev1");
    expect(dev1.comments).toMatchObject([{ id: "c1", author: "Maria", text: "Great write-up" }]);
    expect(JSON.stringify(r.body)).not.toContain("Tom");
  });

  it("a platform with no posts gives an empty list, still 200", async () => {
    const r = await request(app()).get("/mentions?platforms=youtube");
    expect(r.status).toBe(200);
    expect(r.body.posts).toEqual([]);
    expect(r.body.otherPlatforms).toEqual(expect.arrayContaining([{ platform: "facebook", count: 20 }]));
  });

  it.each(["dev to", "devto,,bluesky", "a;b", "x".repeat(31), "devto),social_accounts.platform.eq.(x"])("refuses %j with 400 and runs no query", async (bad) => {
    const r = await request(app()).get("/mentions").query({ platforms: bad });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/platforms must be/);
    expect(current.calls).toEqual([]);
  });

  it("a failing 'Coming soon' count does not break the main answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const real = (current.db as { from: (t: string) => unknown }).from;
    let n = 0;
    (current.db as { from: unknown }).from = (t: string) => {
      n += 1;
      if (n === 2) throw new Error("connection lost"); // the second query is the count
      return real(t);
    };
    const r = await request(app()).get("/mentions?platforms=devto,hashnode");
    expect(r.status).toBe(200);
    expect(r.body.posts.map((p: any) => p.postId)).toEqual(["dev1", "dev2", "hn1"]);
    expect(r.body.otherPlatforms).toEqual([]);
  });
});

describe("GET /mentions without the parameter (API, MCP, SDK, Zapier)", () => {
  it("is unchanged: newest 15 posts of every platform, no otherPlatforms in the answer", async () => {
    const r = await request(app()).get("/mentions");
    expect(r.status).toBe(200);
    expect(r.body.posts).toHaveLength(15);
    expect(r.body.posts.every((p: any) => p.platform === "facebook")).toBe(true);
    expect(r.body).not.toHaveProperty("otherPlatforms");
    expect(current.calls.filter((c) => c.op === "from")).toHaveLength(1); // no extra query
  });
});
