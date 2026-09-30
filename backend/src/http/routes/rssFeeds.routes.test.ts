// RSS feeds API. Login mocked; supabase is the in-memory fake; the feed fetch is mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

const auth = vi.hoisted(() => ({ accountId: "acc1" }));
const feedFetch = vi.hoisted(() => ({ result: null as unknown }));
vi.mock("../auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.accountId = auth.accountId;
    next();
  },
}));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});
vi.mock("../../rssPoller.js", async (orig) => {
  const real = await orig<typeof import("../../rssPoller.js")>();
  return { ...real, fetchFeedText: async () => feedFetch.result };
});

const { buildRssFeedsRouter, MAX_RSS_FEEDS } = await import("./rssFeeds.routes.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildRssFeedsRouter());
  return a;
};
const RSS = "<rss><channel><item><title>One</title><guid>g1</guid></item><item><title>Two</title><guid>g2</guid></item></channel></rss>";

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  auth.accountId = "acc1";
  feedFetch.result = { ok: true, text: RSS };
});

describe("rss feeds API", () => {
  it("adds a feed, remembers the items already in it, and drafts nothing", async () => {
    const r = await request(app()).post("/rss-feeds").send({ url: "https://example.com/feed.xml", label: "Blog" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ url: "https://example.com/feed.xml", label: "Blog", enabled: true });
    expect(tables.rss_feeds[0]).toMatchObject({ primed: true, seen_ids: ["g1", "g2"] });
    expect(tables.scheduled_posts ?? []).toHaveLength(0);
  });

  it("refuses an address that cannot be fetched, and one that is not a feed", async () => {
    feedFetch.result = { ok: false, error: "The feed address is not allowed: must not point at a local address." };
    const bad = await request(app()).post("/rss-feeds").send({ url: "https://localhost/feed" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not allowed/);
    feedFetch.result = { ok: true, text: "<html>not a feed</html>" };
    const notFeed = await request(app()).post("/rss-feeds").send({ url: "https://example.com/" });
    expect(notFeed.status).toBe(400);
    expect(notFeed.body.error).toMatch(/RSS or Atom/);
    expect(tables.rss_feeds ?? []).toHaveLength(0);
  });

  it("stops at the limit, counting only this account", async () => {
    tables.rss_feeds = Array.from({ length: MAX_RSS_FEEDS }, (_, i) => ({ id: `f${i}`, account_id: "acc1", url: "u", enabled: true }));
    expect((await request(app()).post("/rss-feeds").send({ url: "https://example.com/feed.xml" })).status).toBe(400);
    auth.accountId = "acc2";
    expect((await request(app()).post("/rss-feeds").send({ url: "https://example.com/feed.xml" })).status).toBe(201);
  });

  it("turns a feed off and on, and deletes it", async () => {
    const f = (await request(app()).post("/rss-feeds").send({ url: "https://example.com/feed.xml" })).body;
    expect((await request(app()).patch(`/rss-feeds/${f.id}`).send({ enabled: false })).body.enabled).toBe(false);
    expect((await request(app()).delete(`/rss-feeds/${f.id}`)).body).toEqual({ deleted: true });
    expect((await request(app()).get("/rss-feeds")).body.feeds).toHaveLength(0);
  });

  it("never shows or touches another account's feeds", async () => {
    tables.rss_feeds = [{ id: "theirs", account_id: "acc2", url: "u", enabled: true }];
    expect((await request(app()).get("/rss-feeds")).body.feeds).toHaveLength(0);
    expect((await request(app()).patch("/rss-feeds/theirs").send({ enabled: false })).status).toBe(404);
    expect((await request(app()).delete("/rss-feeds/theirs")).status).toBe(404);
  });
});
