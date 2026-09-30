import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LazyRelay, VERSION } from "../src/index.js";
import { FakeApi, KEY, type Reply } from "./fakeApi.js";

const api = new FakeApi();
let client: LazyRelay;

beforeAll(async () => {
  await api.start();
  client = new LazyRelay({ apiKey: KEY, baseUrl: api.baseUrl });
});
afterAll(() => api.stop());
beforeEach(() => api.reset());

interface Case {
  name: string;
  call: (c: LazyRelay) => Promise<unknown>;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  reply?: Reply;
  result?: unknown;
}

const POST_ROW = { id: "p1", status: "pending", scheduled_for: "2026-10-01T09:00:00.000Z" };

const cases: Case[] = [
  { name: "accounts.list", call: (c) => c.accounts.list(), method: "GET", path: "/api/social-accounts", reply: { body: [{ id: "a1", platform: "instagram" }] }, result: [{ id: "a1", platform: "instagram" }] },
  { name: "brands.list", call: (c) => c.brands.list(), method: "GET", path: "/api/brands", reply: { body: [{ id: "b1", name: "Acme" }] }, result: [{ id: "b1", name: "Acme" }] },
  { name: "rules.get() all platforms", call: (c) => c.rules.get(), method: "GET", path: "/api/platforms/rules", query: {}, reply: { body: { platforms: [] } }, result: { platforms: [] } },
  { name: "rules.get(platform)", call: (c) => c.rules.get("tiktok"), method: "GET", path: "/api/platforms/rules", query: { platform: "tiktok" }, reply: { body: { platforms: [{ platform: "tiktok" }] } }, result: { platforms: [{ platform: "tiktok" }] } },
  {
    name: "posts.schedule with a string time",
    call: (c) => c.posts.schedule({ socialAccountId: "a1", content: "Hello", scheduledFor: "2026-10-01T09:00:00Z", tags: ["x"], requiresApproval: true, options: { instagram: { placement: "reel" } } }),
    method: "POST",
    path: "/api/scheduled-posts",
    body: { socialAccountId: "a1", content: "Hello", scheduledFor: "2026-10-01T09:00:00Z", tags: ["x"], requiresApproval: true, options: { instagram: { placement: "reel" } } },
    reply: { status: 201, body: POST_ROW },
    result: POST_ROW,
  },
  {
    name: "posts.schedule turns a Date into ISO",
    call: (c) => c.posts.schedule({ socialAccountId: "a1", content: "Hi", scheduledFor: new Date("2026-10-01T09:00:00Z"), tiktokPrivacyLevel: "SELF_ONLY" }),
    method: "POST",
    path: "/api/scheduled-posts",
    body: { socialAccountId: "a1", content: "Hi", scheduledFor: "2026-10-01T09:00:00.000Z", tiktokPrivacyLevel: "SELF_ONLY" },
    reply: { status: 201, body: POST_ROW },
    result: POST_ROW,
  },
  { name: "posts.approve", call: (c) => c.posts.approve("p1"), method: "PATCH", path: "/api/scheduled-posts/p1/approve", reply: { body: POST_ROW }, result: POST_ROW },
  { name: "posts.proofLink", call: (c) => c.posts.proofLink("p1"), method: "GET", path: "/api/scheduled-posts/p1/proof-link", reply: { body: { url: "https://lazyrelay.com/verify/r1" } }, result: { url: "https://lazyrelay.com/verify/r1" } },
  {
    name: "posts.duplicate",
    call: (c) => c.posts.duplicate("p1", { scheduledFor: new Date("2026-11-01T10:00:00Z"), requiresApproval: false }),
    method: "POST",
    path: "/api/scheduled-posts/p1/duplicate",
    body: { scheduledFor: "2026-11-01T10:00:00.000Z", requiresApproval: false },
    reply: { status: 201, body: POST_ROW },
    result: POST_ROW,
  },
  {
    name: "posts.createDraft",
    call: (c) => c.posts.createDraft({ content: "Draft text", plannedDate: "2026-10-05", mediaUrl: "https://x.test/a.png" }),
    method: "POST",
    path: "/api/scheduled-posts/draft",
    body: { content: "Draft text", plannedDate: "2026-10-05", mediaUrl: "https://x.test/a.png" },
    reply: { status: 201, body: { id: "d1", status: "draft" } },
    result: { id: "d1", status: "draft" },
  },
  {
    name: "posts.scheduleDraft",
    call: (c) => c.posts.scheduleDraft("d1", { socialAccountId: "a1", content: "Final", scheduledFor: "2026-10-02T08:00:00Z" }),
    method: "PATCH",
    path: "/api/scheduled-posts/d1/schedule",
    body: { socialAccountId: "a1", content: "Final", scheduledFor: "2026-10-02T08:00:00Z" },
    reply: { body: POST_ROW },
    result: POST_ROW,
  },
  {
    name: "posts.update (null clears a field)",
    call: (c) => c.posts.update("p1", { content: "New", mediaUrl: null, tags: ["a", "b"] }),
    method: "PATCH",
    path: "/api/scheduled-posts/p1",
    body: { content: "New", mediaUrl: null, tags: ["a", "b"] },
    reply: { body: POST_ROW },
    result: POST_ROW,
  },
  {
    name: "posts.reschedule",
    call: (c) => c.posts.reschedule("p1", new Date("2026-12-01T00:00:00Z")),
    method: "PATCH",
    path: "/api/scheduled-posts/p1/reschedule",
    body: { scheduledFor: "2026-12-01T00:00:00.000Z" },
    reply: { body: POST_ROW },
    result: POST_ROW,
  },
  { name: "posts.pause", call: (c) => c.posts.pause("p1"), method: "PATCH", path: "/api/scheduled-posts/p1/pause", reply: { body: POST_ROW }, result: POST_ROW },
  { name: "posts.resume", call: (c) => c.posts.resume("p1"), method: "PATCH", path: "/api/scheduled-posts/p1/resume", reply: { body: POST_ROW }, result: POST_ROW },
  { name: "posts.delete (204 no content)", call: (c) => c.posts.delete("p1"), method: "DELETE", path: "/api/scheduled-posts/p1", reply: { status: 204 }, result: undefined },
  { name: "posts.history", call: (c) => c.posts.history({ limit: 20, before: "2026-09-01T00:00:00Z" }), method: "GET", path: "/api/scheduled-posts/history", query: { limit: "20", before: "2026-09-01T00:00:00Z" }, reply: { body: [] }, result: [] },
  { name: "posts.history with no options", call: (c) => c.posts.history(), method: "GET", path: "/api/scheduled-posts/history", query: {}, reply: { body: [] }, result: [] },
  { name: "slots.list", call: (c) => c.slots.list(), method: "GET", path: "/api/posting-slots", reply: { body: { maxSlots: 20, slots: [] } }, result: { maxSlots: 20, slots: [] } },
  { name: "slots.next", call: (c) => c.slots.next("a1"), method: "GET", path: "/api/posting-slots/next", query: { socialAccountId: "a1" }, reply: { body: { scheduledFor: "2026-10-03T07:00:00.000Z" } }, result: { scheduledFor: "2026-10-03T07:00:00.000Z" } },
  { name: "snippets.list", call: (c) => c.snippets.list(), method: "GET", path: "/api/snippets", reply: { body: { maxSnippets: 50, snippets: [] } }, result: { maxSnippets: 50, snippets: [] } },
  { name: "tiktok.creatorInfo", call: (c) => c.tiktok.creatorInfo("a1"), method: "GET", path: "/api/social-accounts/a1/tiktok-creator-info", reply: { body: { nickname: "n", canPost: true, privacyLevelOptions: ["SELF_ONLY"] } }, result: { nickname: "n", canPost: true, privacyLevelOptions: ["SELF_ONLY"] } },
  { name: "pinterest.boards", call: (c) => c.pinterest.boards("a1"), method: "GET", path: "/api/social-accounts/a1/boards", reply: { body: [{ id: "b", name: "Board" }] }, result: [{ id: "b", name: "Board" }] },
  { name: "analytics.summary with filters", call: (c) => c.analytics.summary({ days: 7, brand: "Acme Co", tag: "spring" }), method: "GET", path: "/api/analytics/summary", query: { days: "7", brand: "Acme Co", tag: "spring" }, reply: { body: { totalPosts: 3 } }, result: { totalPosts: 3 } },
  { name: "analytics.summary with no filters", call: (c) => c.analytics.summary(), method: "GET", path: "/api/analytics/summary", query: {}, reply: { body: { totalPosts: 0 } }, result: { totalPosts: 0 } },
  { name: "mentions.list", call: (c) => c.mentions.list(), method: "GET", path: "/api/mentions", reply: { body: { posts: [] } }, result: { posts: [] } },
  { name: "reviewLinks.list", call: (c) => c.reviewLinks.list(), method: "GET", path: "/api/review-links", reply: { body: { maxLinks: 3, links: [] } }, result: { maxLinks: 3, links: [] } },
  {
    name: "reviewLinks.create adds the public url",
    call: (c) => c.reviewLinks.create({ label: "Acme", expiresInDays: 14 }),
    method: "POST",
    path: "/api/review-links",
    body: { label: "Acme", expiresInDays: 14 },
    reply: { status: 201, body: { id: "r1", token: "tok123", status: "active" } },
    result: { id: "r1", token: "tok123", status: "active", url: "https://lazyrelay.com/review/tok123" },
  },
  { name: "reviewLinks.revoke", call: (c) => c.reviewLinks.revoke("r1"), method: "DELETE", path: "/api/review-links/r1", reply: { body: { revoked: true } }, result: { revoked: true } },
  { name: "feedback.list", call: (c) => c.feedback.list("p1"), method: "GET", path: "/api/scheduled-posts/p1/review-comments", reply: { body: { comments: [] } }, result: { comments: [] } },
  {
    name: "feedback.reply",
    call: (c) => c.feedback.reply("p1", "Thanks, updated"),
    method: "POST",
    path: "/api/scheduled-posts/p1/review-comments",
    body: { body: "Thanks, updated" },
    reply: { status: 201, body: { id: "c1", body: "Thanks, updated" } },
    result: { id: "c1", body: "Thanks, updated" },
  },
  { name: "rssFeeds.list", call: (c) => c.rssFeeds.list(), method: "GET", path: "/api/rss-feeds", reply: { body: { maxFeeds: 3, feeds: [] } }, result: { maxFeeds: 3, feeds: [] } },
  {
    name: "rssFeeds.create",
    call: (c) => c.rssFeeds.create({ url: "https://blog.test/feed.xml", label: "Blog" }),
    method: "POST",
    path: "/api/rss-feeds",
    body: { url: "https://blog.test/feed.xml", label: "Blog" },
    reply: { status: 201, body: { id: "f1", enabled: true } },
    result: { id: "f1", enabled: true },
  },
  { name: "rssFeeds.setEnabled", call: (c) => c.rssFeeds.setEnabled("f1", false), method: "PATCH", path: "/api/rss-feeds/f1", body: { enabled: false }, reply: { body: { id: "f1", enabled: false } }, result: { id: "f1", enabled: false } },
  { name: "rssFeeds.delete", call: (c) => c.rssFeeds.delete("f1"), method: "DELETE", path: "/api/rss-feeds/f1", reply: { body: { deleted: true } }, result: { deleted: true } },
];

describe("every SDK method sends the right request", () => {
  it.each(cases)("$name", async (c) => {
    api.replyWith(c.reply ?? { body: {} });
    const result = await c.call(client);
    expect(api.requests).toHaveLength(1);
    const req = api.last;
    expect(req.method).toBe(c.method);
    expect(req.path).toBe(c.path);
    expect(req.query).toEqual(c.query ?? {});
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.headers.accept).toBe("application/json");
    expect(req.headers["user-agent"]).toBe(`lazyrelay-sdk-node/${VERSION}`);
    if (c.body !== undefined) {
      expect(req.headers["content-type"]).toBe("application/json");
      expect(req.json).toEqual(c.body);
    } else {
      expect(req.raw.length).toBe(0);
      expect(req.headers["content-type"]).toBeUndefined();
    }
    expect(result).toEqual(c.result);
  });
});

describe("posts.publishNow", () => {
  it("posts with scheduledFor set to now and no other surprises", async () => {
    api.replyWith({ status: 201, body: POST_ROW });
    const before = Date.now();
    await client.posts.publishNow({ socialAccountId: "a1", content: "Now", mediaUrl: "https://x.test/v.mp4" });
    const after = Date.now();
    const req = api.last;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/scheduled-posts");
    const body = req.json as Record<string, string>;
    expect(body).toMatchObject({ socialAccountId: "a1", content: "Now", mediaUrl: "https://x.test/v.mp4" });
    const sent = new Date(body.scheduledFor).getTime();
    expect(sent).toBeGreaterThanOrEqual(before);
    expect(sent).toBeLessThanOrEqual(after);
  });
});

describe("posts.list", () => {
  const rows = [
    { id: "1", status: "pending", social_account_id: "a1" },
    { id: "2", status: "posted", social_account_id: "a1" },
    { id: "3", status: "pending", social_account_id: "a2" },
    { id: "4", status: "draft", social_account_id: null },
  ];

  it("returns everything the API returns when no filter is given", async () => {
    api.replyWith({ body: rows });
    expect(await client.posts.list()).toEqual(rows);
    expect(api.last.method).toBe("GET");
    expect(api.last.path).toBe("/api/scheduled-posts");
    expect(api.last.query).toEqual({});
  });

  it("filters by status and account on the client and applies limit last", async () => {
    api.replyWith({ body: rows });
    expect((await client.posts.list({ status: "pending" })).map((p) => p.id)).toEqual(["1", "3"]);
    expect((await client.posts.list({ socialAccountId: "a1" })).map((p) => p.id)).toEqual(["1", "2"]);
    expect((await client.posts.list({ status: "pending", socialAccountId: "a2" })).map((p) => p.id)).toEqual(["3"]);
    expect((await client.posts.list({ status: "pending", limit: 1 })).map((p) => p.id)).toEqual(["1"]);
    expect(await client.posts.list({ limit: 0 })).toEqual([]);
  });

  it("sends the brand filter to the API", async () => {
    api.replyWith({ body: [] });
    await client.posts.list({ brand: "Acme" });
    expect(api.last.query).toEqual({ brand: "Acme" });
  });
});

describe("path safety", () => {
  it("encodes ids so they cannot change the path", async () => {
    api.replyWith({ body: {} });
    await client.posts.approve("a/b?c=d");
    expect(api.last.raw.length).toBe(0);
    expect(api.last.path).toBe("/api/scheduled-posts/a%2Fb%3Fc%3Dd/approve");
  });
});

describe("client construction", () => {
  it("falls back to LAZYRELAY_API_KEY", async () => {
    const saved = process.env.LAZYRELAY_API_KEY;
    process.env.LAZYRELAY_API_KEY = "lzr_live_FROMENV";
    try {
      const c = new LazyRelay({ baseUrl: api.baseUrl });
      api.replyWith({ body: [] });
      await c.accounts.list();
      expect(api.last.headers.authorization).toBe("Bearer lzr_live_FROMENV");
    } finally {
      if (saved === undefined) delete process.env.LAZYRELAY_API_KEY;
      else process.env.LAZYRELAY_API_KEY = saved;
    }
  });

  it("prefers an explicit apiKey over the environment", async () => {
    const saved = process.env.LAZYRELAY_API_KEY;
    process.env.LAZYRELAY_API_KEY = "lzr_live_FROMENV";
    try {
      const c = new LazyRelay({ apiKey: "lzr_live_EXPLICIT", baseUrl: api.baseUrl });
      api.replyWith({ body: [] });
      await c.accounts.list();
      expect(api.last.headers.authorization).toBe("Bearer lzr_live_EXPLICIT");
    } finally {
      if (saved === undefined) delete process.env.LAZYRELAY_API_KEY;
      else process.env.LAZYRELAY_API_KEY = saved;
    }
  });

  it("throws an auth error at construction when there is no key anywhere", () => {
    const saved = process.env.LAZYRELAY_API_KEY;
    delete process.env.LAZYRELAY_API_KEY;
    try {
      expect(() => new LazyRelay({ baseUrl: api.baseUrl })).toThrowError(/No API key/);
      try {
        new LazyRelay({ apiKey: "   " });
      } catch (err) {
        expect((err as { kind: string }).kind).toBe("auth");
      }
    } finally {
      if (saved !== undefined) process.env.LAZYRELAY_API_KEY = saved;
    }
  });

  it("accepts a trailing slash on baseUrl", async () => {
    const c = new LazyRelay({ apiKey: KEY, baseUrl: `${api.baseUrl}/` });
    api.replyWith({ body: [] });
    await c.accounts.list();
    expect(api.last.path).toBe("/api/social-accounts");
  });

  it("uses a custom fetch when one is given", async () => {
    const seen: string[] = [];
    const c = new LazyRelay({
      apiKey: KEY,
      baseUrl: "https://example.test/api",
      fetch: async (input, init) => {
        seen.push(`${init?.method} ${String(input)}`);
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    expect(await c.accounts.list()).toEqual([]);
    expect(seen).toEqual(["GET https://example.test/api/social-accounts"]);
  });

  it("times out a slow response with a retryable local error", async () => {
    api.reset(() => ({ status: 200, body: {} }));
    const c = new LazyRelay({
      apiKey: KEY,
      baseUrl: api.baseUrl,
      timeoutMs: 50,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    await expect(c.posts.approve("p1")).rejects.toMatchObject({ name: "LazyRelayError", status: 0, retryable: true, message: expect.stringContaining("timed out") });
  });
});
