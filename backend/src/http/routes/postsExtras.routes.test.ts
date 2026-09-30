// Tags, extra images and self-replies through the REAL post routes: a draft keeps
// them, editing changes them, promoting a draft applies the platform's rules, and
// duplicating a post carries them. Login is mocked; supabase is the in-memory fake.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

const auth = vi.hoisted(() => ({ accountId: "acc1" }));
vi.mock("../auth.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.accountId = auth.accountId;
      req.db = { from: (t: string) => f.makeBuilder(t) };
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});
vi.mock("../../googleCalendar/outboundSync.js", () => ({ syncPostToCalendar: async () => {}, deletePostFromCalendar: async () => {} }));
vi.mock("../../googleSheets/outboundSync.js", () => ({ syncAccountSheet: async () => {} }));
vi.mock("../../urlSafety.js", () => ({ isSafeMediaUrl: async () => ({ safe: true, addresses: ["8.8.8.8"] }) }));

const { buildPostsRouter } = await import("./posts.routes.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildPostsRouter());
  return a;
};

const IMG = (n: number) => `https://cdn.example.com/${n}.jpg`;
const future = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  auth.accountId = "acc1";
  tables.subscriptions = [{ account_id: "acc1", tier: "enterprise", status: "active" }];
  tables.social_accounts = [
    { id: "ig", account_id: "acc1", platform: "instagram", platform_account_id: "ig1", display_name: "ig" },
    { id: "tt", account_id: "acc1", platform: "tiktok", platform_account_id: "tt1", display_name: "tt" },
  ];
});

const draft = (over: Record<string, unknown> = {}) => request(app()).post("/scheduled-posts/draft").send({ content: "Hello", ...over });

describe("drafts keep the extras", () => {
  it("stores tags, extra images and a self-reply on a new draft", async () => {
    const r = await draft({ mediaUrl: IMG(1), tags: ["Launch"], mediaUrls: [IMG(2), IMG(3)], selfReplyText: "Thanks!", selfReplyAtLikes: 25 });
    expect(r.status).toBe(201);
    expect(tables.scheduled_posts[0]).toMatchObject({ status: "draft", tags: ["launch"], media_urls: [IMG(2), IMG(3)], self_reply_text: "Thanks!", self_reply_at_likes: 25 });
  });

  it("refuses bad extras on a draft", async () => {
    expect((await draft({ tags: "nope" })).status).toBe(400);
    expect((await draft({ mediaUrls: "nope" })).status).toBe(400);
    expect((await draft({ selfReplyText: "only text" })).status).toBe(400);
    expect(tables.scheduled_posts ?? []).toHaveLength(0);
  });

  it("editing a draft changes only what is sent", async () => {
    await draft({ mediaUrl: IMG(1), tags: ["a"], mediaUrls: [IMG(2)], selfReplyText: "Thanks!", selfReplyAtLikes: 25 });
    const id = tables.scheduled_posts[0].id;
    const r = await request(app()).patch(`/scheduled-posts/${id}`).send({ tags: ["b", "c"] });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts[0]).toMatchObject({ tags: ["b", "c"], media_urls: [IMG(2)], self_reply_text: "Thanks!", self_reply_at_likes: 25 });
  });
});

describe("editing a scheduled post checks its platform", () => {
  const pending = (platformId: string) => {
    tables.scheduled_posts = [{ id: "p1", account_id: "acc1", social_account_id: platformId, status: "pending", content: "x", media_url: IMG(1), tags: [], media_urls: [], self_reply_text: null, self_reply_at_likes: null }];
  };
  it("accepts extra images on an Instagram post", async () => {
    pending("ig");
    const r = await request(app()).patch("/scheduled-posts/p1").send({ mediaUrls: [IMG(2)] });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts[0].media_urls).toEqual([IMG(2)]);
  });
  it("refuses them on a TikTok post, and leaves the post untouched", async () => {
    pending("tt");
    const r = await request(app()).patch("/scheduled-posts/p1").send({ mediaUrls: [IMG(2)] });
    expect(r.status).toBe(400);
    expect(tables.scheduled_posts[0].media_urls).toEqual([]);
  });
});

describe("promoting a draft", () => {
  it("applies the platform's rules and stores the extras on the scheduled post", async () => {
    await draft({ mediaUrl: IMG(1), tags: ["launch"], mediaUrls: [IMG(2)], selfReplyText: "Thanks!", selfReplyAtLikes: 10 });
    const id = tables.scheduled_posts[0].id;
    const r = await request(app())
      .patch(`/scheduled-posts/${id}/schedule`)
      .send({ socialAccountId: "ig", content: "Hello", mediaUrl: IMG(1), tags: ["launch"], mediaUrls: [IMG(2)], selfReplyText: "Thanks!", selfReplyAtLikes: 10, scheduledFor: future() });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts[0]).toMatchObject({ status: "pending", social_account_id: "ig", tags: ["launch"], media_urls: [IMG(2)], self_reply_text: "Thanks!", self_reply_at_likes: 10 });
  });

  it("refuses extra images when the chosen platform cannot take them", async () => {
    await draft({ mediaUrl: IMG(1), mediaUrls: [IMG(2)] });
    const id = tables.scheduled_posts[0].id;
    const r = await request(app())
      .patch(`/scheduled-posts/${id}/schedule`)
      .send({ socialAccountId: "tt", content: "Hello", mediaUrl: IMG(1), mediaUrls: [IMG(2)], tiktokPrivacyLevel: "SELF_ONLY", scheduledFor: future() });
    expect(r.status).toBe(400);
    expect(tables.scheduled_posts[0].status).toBe("draft");
  });
});

describe("duplicating a post", () => {
  it("carries the tags, extra images and self-reply to the copy", async () => {
    tables.scheduled_posts = [
      {
        id: "orig",
        account_id: "acc1",
        social_account_id: "ig",
        status: "posted",
        content: "Hello",
        media_url: IMG(1),
        tags: ["launch"],
        media_urls: [IMG(2)],
        self_reply_text: "Thanks!",
        self_reply_at_likes: 10,
        self_reply_done_at: "2026-09-30T10:00:00Z",
      },
    ];
    const r = await request(app()).post("/scheduled-posts/orig/duplicate").send({ scheduledFor: future() });
    expect(r.status).toBe(201);
    const copy = tables.scheduled_posts.find((p) => p.id !== "orig")!;
    expect(copy).toMatchObject({ tags: ["launch"], media_urls: [IMG(2)], self_reply_text: "Thanks!", self_reply_at_likes: 10 });
    expect(copy.self_reply_done_at ?? null).toBeNull(); // the copy can send its own reply
  });
});
