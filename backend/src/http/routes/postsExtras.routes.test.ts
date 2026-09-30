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
      // Like production: the customer-scoped client is refused by row-level security on tables only the
      // backend may write (post_review_comments), so a route that wrongly writes through req.db fails here too.
      req.db = {
        from: (t: string) =>
          t === "post_review_comments"
            ? { insert: async () => ({ data: null, error: { message: "new row violates row-level security policy" } }), select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }
            : f.makeBuilder(t),
      };
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

describe("platform options through the real routes (master list #20)", () => {
  it("a draft keeps options for every platform until it is scheduled", async () => {
    const r = await draft({ mediaUrl: IMG(1), options: { tiktok: { aiGenerated: true }, chain: ["two"], instagram: { placement: "story" } } });
    expect(r.status).toBe(201);
    expect(tables.scheduled_posts[0].options).toEqual({ tiktok: { aiGenerated: true }, chain: ["two"], instagram: { placement: "story" } });
  });

  it("a draft refuses a wrongly shaped option", async () => {
    expect((await draft({ options: { tiktok: { aiGenerated: "yes" } } })).status).toBe(400);
    expect((await draft({ options: { myspace: {} } })).status).toBe(400);
  });

  it("promoting a draft keeps only the chosen platform's options and checks them", async () => {
    await draft({ mediaUrl: IMG(1), options: { instagram: { placement: "story" } } });
    const id = tables.scheduled_posts[0].id;
    const r = await request(app())
      .patch(`/scheduled-posts/${id}/schedule`)
      .send({ socialAccountId: "ig", content: "Hello", mediaUrl: IMG(1), options: { instagram: { placement: "story" } }, scheduledFor: future() });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts[0]).toMatchObject({ status: "pending", options: { instagram: { placement: "story" } } });
  });

  it("refuses another platform's options, and a story with no media", async () => {
    await draft({ mediaUrl: IMG(1) });
    const id = tables.scheduled_posts[0].id;
    const wrong = await request(app())
      .patch(`/scheduled-posts/${id}/schedule`)
      .send({ socialAccountId: "ig", content: "Hello", mediaUrl: IMG(1), options: { tiktok: { aiGenerated: true } }, scheduledFor: future() });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/options\.tiktok is not used by this platform \(it takes options\.instagram\)/);
    const noMedia = await request(app())
      .patch(`/scheduled-posts/${id}/schedule`)
      .send({ socialAccountId: "ig", content: "Hello", options: { instagram: { placement: "story" } }, scheduledFor: future() });
    expect(noMedia.status).toBe(400);
    expect(tables.scheduled_posts[0].status).toBe("draft");
  });

  it("editing a scheduled TikTok post accepts the AI label and refuses a story option", async () => {
    tables.scheduled_posts = [{ id: "p1", account_id: "acc1", social_account_id: "tt", status: "pending", content: "x", media_url: IMG(1), tags: [], media_urls: [], self_reply_text: null, self_reply_at_likes: null, options: {} }];
    const ok = await request(app()).patch("/scheduled-posts/p1").send({ options: { tiktok: { aiGenerated: true } } });
    expect(ok.status).toBe(200);
    expect(tables.scheduled_posts[0].options).toEqual({ tiktok: { aiGenerated: true } });
    const bad = await request(app()).patch("/scheduled-posts/p1").send({ options: { instagram: { placement: "story" } } });
    expect(bad.status).toBe(400);
    expect(tables.scheduled_posts[0].options).toEqual({ tiktok: { aiGenerated: true } });
  });

  it("duplicating a post carries its options", async () => {
    tables.scheduled_posts = [{ id: "orig", account_id: "acc1", social_account_id: "ig", status: "posted", content: "Hello", media_url: IMG(1), tags: [], media_urls: [], options: { instagram: { placement: "story" } } }];
    const r = await request(app()).post("/scheduled-posts/orig/duplicate").send({ scheduledFor: future() });
    expect(r.status).toBe(201);
    expect(tables.scheduled_posts.find((p) => p.id !== "orig")).toMatchObject({ options: { instagram: { placement: "story" } } });
  });
});

describe("editing a post a client asked changes on (master list #23)", () => {
  const waiting = () => {
    tables.accounts = [{ id: "acc1", business_name: "Agency Co" }];
    tables.post_review_comments = [];
    tables.scheduled_posts = [{ id: "w1", account_id: "acc1", social_account_id: "ig", status: "needs_approval", content: "Friday", media_url: IMG(1), tags: [], media_urls: [], options: {}, changes_requested_at: "2026-09-30T10:00:00Z" }];
  };
  it("a post waiting for approval can be edited; the change request clears and the client is told", async () => {
    waiting();
    const r = await request(app()).patch("/scheduled-posts/w1").send({ content: "Saturday" });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts[0]).toMatchObject({ content: "Saturday", status: "needs_approval", changes_requested_at: null });
    expect(tables.post_review_comments[0]).toMatchObject({ post_id: "w1", author_kind: "owner", kind: "updated" });
  });
  it("a change that is not to the content or media leaves the request open", async () => {
    waiting();
    await request(app()).patch("/scheduled-posts/w1").send({ tags: ["sale"] });
    expect(tables.scheduled_posts[0].changes_requested_at).toBe("2026-09-30T10:00:00Z");
    expect(tables.post_review_comments).toHaveLength(0);
  });
  it("posts that are already posted still cannot be edited", async () => {
    tables.scheduled_posts = [{ id: "d1", account_id: "acc1", social_account_id: "ig", status: "posted", content: "x", media_url: null }];
    expect((await request(app()).patch("/scheduled-posts/d1").send({ content: "y" })).status).toBe(409);
  });
});
