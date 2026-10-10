// The delay before the first comment on every write path: new post, bulk, draft, edit, promoting a
// draft, duplicate, and recurring schedules (create, edit, and the posts they generate).
// Login is mocked; supabase is the in-memory fake.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

vi.mock("../auth.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.accountId = "acc1";
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
const { buildRecurringSchedulesRouter } = await import("./recurringSchedules.routes.js");
const { extrasForPlatform } = await import("../../postExtras.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildPostsRouter());
  a.use(buildRecurringSchedulesRouter());
  return a;
};

const IMG = "https://cdn.example.com/1.jpg";
const future = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
const schedule = (over: Record<string, unknown> = {}) =>
  request(app()).post("/scheduled-posts").send({ socialAccountId: "ig", content: "Hello", mediaUrl: IMG, scheduledFor: future(), firstComment: "First!", ...over });
const draft = (over: Record<string, unknown> = {}) => request(app()).post("/scheduled-posts/draft").send({ content: "Hello", ...over });

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.subscriptions = [{ account_id: "acc1", tier: "business", status: "active" }];
  tables.social_accounts = [
    { id: "ig", account_id: "acc1", platform: "instagram", platform_account_id: "ig1", display_name: "ig" },
    { id: "fb", account_id: "acc1", platform: "facebook", platform_account_id: "fb1", display_name: "fb" },
    { id: "tt", account_id: "acc1", platform: "tiktok", platform_account_id: "tt1", display_name: "tt" },
    { id: "bs", account_id: "acc1", platform: "bluesky", platform_account_id: "bs1", display_name: "bs" },
  ];
});

describe("POST /scheduled-posts", () => {
  it("stores the delay and returns it (round trip)", async () => {
    const r = await schedule({ firstCommentDelayMinutes: 30 });
    expect(r.status).toBe(201);
    expect(r.body.first_comment_delay_minutes).toBe(30);
    expect(tables.scheduled_posts[0]).toMatchObject({ first_comment: "First!", first_comment_delay_minutes: 30 });
  });

  it("accepts the whole range, including 24 hours, on Facebook too", async () => {
    expect((await schedule({ socialAccountId: "fb", firstCommentDelayMinutes: 1440 })).status).toBe(201);
    expect(tables.scheduled_posts[0].first_comment_delay_minutes).toBe(1440);
  });

  it("without a delay (or with 0) the post is exactly as before: no delay stored", async () => {
    expect((await schedule()).status).toBe(201);
    expect((await schedule({ firstCommentDelayMinutes: 0 })).status).toBe(201);
    for (const p of tables.scheduled_posts) expect(p.first_comment_delay_minutes ?? null).toBeNull();
  });

  it("refuses a negative, fractional, text or over-24-hours delay", async () => {
    for (const bad of [-5, 2.5, "soon", 1441, 99999]) {
      const r = await schedule({ firstCommentDelayMinutes: bad });
      expect(r.status, String(bad)).toBe(400);
      expect(r.body.error).toMatch(/firstCommentDelayMinutes/);
    }
    expect(tables.scheduled_posts ?? []).toHaveLength(0);
  });

  it("refuses a delay with no first comment", async () => {
    for (const comment of [undefined, "", "   "]) {
      const r = await schedule({ firstComment: comment, firstCommentDelayMinutes: 15 });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("A delay before the first comment needs a first comment to delay");
    }
  });

  it("refuses a delay on a platform that does not post first comments", async () => {
    const r = await request(app()).post("/scheduled-posts").send({ socialAccountId: "bs", content: "Hello", scheduledFor: future(), firstComment: "First!", firstCommentDelayMinutes: 15 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Delaying the first comment is only available for Facebook and Instagram posts");
    expect(tables.scheduled_posts ?? []).toHaveLength(0);
  });
});

describe("POST /scheduled-posts/bulk", () => {
  it("checks the delay row by row and keeps going past a bad row", async () => {
    const row = (over: Record<string, unknown>) => ({ socialAccountId: "ig", content: "Hello", mediaUrl: IMG, scheduledFor: future(), firstComment: "First!", ...over });
    const r = await request(app())
      .post("/scheduled-posts/bulk")
      .send({ posts: [row({ firstCommentDelayMinutes: 60 }), row({ firstCommentDelayMinutes: 5000 }), row({ firstComment: undefined, firstCommentDelayMinutes: 5 })] });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => x.status)).toEqual([201, 400, 400]);
    expect(tables.scheduled_posts).toHaveLength(1);
    expect(tables.scheduled_posts[0].first_comment_delay_minutes).toBe(60);
  });
});

describe("drafts", () => {
  it("keep the delay with the comment", async () => {
    const r = await draft({ firstComment: "First!", firstCommentDelayMinutes: 120 });
    expect(r.status).toBe(201);
    expect(tables.scheduled_posts[0]).toMatchObject({ status: "draft", first_comment: "First!", first_comment_delay_minutes: 120 });
  });

  it("refuse a bad shape, or a delay with no comment", async () => {
    expect((await draft({ firstComment: "First!", firstCommentDelayMinutes: -1 })).status).toBe(400);
    expect((await draft({ firstComment: "First!", firstCommentDelayMinutes: 1441 })).status).toBe(400);
    expect((await draft({ firstCommentDelayMinutes: 15 })).status).toBe(400);
    expect(tables.scheduled_posts ?? []).toHaveLength(0);
  });

  it("editing a draft can set, change and clear the delay", async () => {
    await draft({ firstComment: "First!" });
    const id = tables.scheduled_posts[0].id;
    expect((await request(app()).patch(`/scheduled-posts/${id}`).send({ firstCommentDelayMinutes: 15 })).status).toBe(200);
    expect(tables.scheduled_posts[0].first_comment_delay_minutes).toBe(15);
    expect((await request(app()).patch(`/scheduled-posts/${id}`).send({ firstCommentDelayMinutes: 0 })).status).toBe(200);
    expect(tables.scheduled_posts[0].first_comment_delay_minutes).toBeNull();
  });

  it("clearing the comment clears the delay with it, instead of refusing the edit", async () => {
    await draft({ firstComment: "First!", firstCommentDelayMinutes: 30 });
    const id = tables.scheduled_posts[0].id;
    const r = await request(app()).patch(`/scheduled-posts/${id}`).send({ firstComment: null });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts[0]).toMatchObject({ first_comment: null, first_comment_delay_minutes: null });
  });

  it("an edit that sets a delay but empties the comment in the same request is refused", async () => {
    await draft({ firstComment: "First!" });
    const id = tables.scheduled_posts[0].id;
    expect((await request(app()).patch(`/scheduled-posts/${id}`).send({ firstComment: "", firstCommentDelayMinutes: 30 })).status).toBe(400);
  });
});

describe("editing a scheduled post checks its platform", () => {
  const pending = (accountId: string, over: Record<string, unknown> = {}) => {
    tables.scheduled_posts = [{ id: "p1", account_id: "acc1", social_account_id: accountId, status: "pending", content: "x", media_url: IMG, tags: [], media_urls: [], first_comment: "First!", first_comment_delay_minutes: null, ...over }];
  };
  it("accepts a delay on an Instagram post", async () => {
    pending("ig");
    const r = await request(app()).patch("/scheduled-posts/p1").send({ firstCommentDelayMinutes: 45 });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts[0].first_comment_delay_minutes).toBe(45);
    expect(r.body.first_comment_delay_minutes).toBe(45);
  });
  it("refuses it on a Bluesky post and leaves the post untouched", async () => {
    pending("bs");
    const r = await request(app()).patch("/scheduled-posts/p1").send({ firstCommentDelayMinutes: 45 });
    expect(r.status).toBe(400);
    expect(tables.scheduled_posts[0].first_comment_delay_minutes).toBeNull();
  });
  it("editing only the comment text keeps the stored delay", async () => {
    pending("ig", { first_comment_delay_minutes: 30 });
    const r = await request(app()).patch("/scheduled-posts/p1").send({ firstComment: "New words" });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts[0]).toMatchObject({ first_comment: "New words", first_comment_delay_minutes: 30 });
  });
  it("an edit that does not touch the comment or delay still works as before", async () => {
    pending("ig", { first_comment_delay_minutes: 30 });
    const r = await request(app()).patch("/scheduled-posts/p1").send({ content: "new" });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts[0]).toMatchObject({ content: "new", first_comment_delay_minutes: 30 });
  });
});

describe("promoting a draft", () => {
  it("applies the platform rule and stores the delay on the scheduled post", async () => {
    await draft({ mediaUrl: IMG, firstComment: "First!", firstCommentDelayMinutes: 30 });
    const id = tables.scheduled_posts[0].id;
    const r = await request(app())
      .patch(`/scheduled-posts/${id}/schedule`)
      .send({ socialAccountId: "ig", content: "Hello", mediaUrl: IMG, firstComment: "First!", firstCommentDelayMinutes: 30, scheduledFor: future() });
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts[0]).toMatchObject({ status: "pending", first_comment_delay_minutes: 30 });
  });

  it("refuses it when the chosen platform cannot post first comments, and the draft stays a draft", async () => {
    await draft({ firstComment: "First!", firstCommentDelayMinutes: 30 });
    const id = tables.scheduled_posts[0].id;
    const r = await request(app())
      .patch(`/scheduled-posts/${id}/schedule`)
      .send({ socialAccountId: "bs", content: "Hello", firstComment: "First!", firstCommentDelayMinutes: 30, scheduledFor: future() });
    expect(r.status).toBe(400);
    expect(tables.scheduled_posts[0].status).toBe("draft");
  });
});

describe("duplicating a post", () => {
  it("carries the delay to the copy", async () => {
    tables.scheduled_posts = [{ id: "orig", account_id: "acc1", social_account_id: "ig", status: "posted", content: "Hello", media_url: IMG, tags: [], media_urls: [], first_comment: "First!", first_comment_delay_minutes: 360 }];
    const r = await request(app()).post("/scheduled-posts/orig/duplicate").send({ scheduledFor: future() });
    expect(r.status).toBe(201);
    expect(tables.scheduled_posts.find((p) => p.id !== "orig")).toMatchObject({ first_comment: "First!", first_comment_delay_minutes: 360 });
  });
});

describe("recurring schedules", () => {
  const recurring = (over: Record<string, unknown> = {}) =>
    request(app()).post("/recurring-schedules").send({ content: "Weekly", mediaUrl: IMG, socialAccountIds: ["ig"], daysOfWeek: [1], timeOfDay: "09:00", timezone: "Africa/Johannesburg", firstComment: "First!", ...over });

  it("keeps the delay when created, and refuses bad values", async () => {
    const ok = await recurring({ firstCommentDelayMinutes: 30 });
    expect(ok.status).toBe(201);
    expect(ok.body.first_comment_delay_minutes).toBe(30);
    expect(tables.recurring_schedules[0].first_comment_delay_minutes).toBe(30);
    for (const bad of [-1, 1.5, 1441]) expect((await recurring({ firstCommentDelayMinutes: bad })).status).toBe(400);
    expect((await recurring({ firstComment: undefined, firstCommentDelayMinutes: 30 })).status).toBe(400);
    expect(tables.recurring_schedules).toHaveLength(1);
  });

  it("refuses a delay when no target can post first comments, accepts it when one can", async () => {
    expect((await recurring({ socialAccountIds: ["bs", "tt"], firstCommentDelayMinutes: 30, tiktokPrivacyLevel: "SELF_ONLY" })).status).toBe(400);
    expect((await recurring({ socialAccountIds: ["bs", "ig"], firstCommentDelayMinutes: 30 })).status).toBe(201);
  });

  it("an edit can change and clear the delay; clearing the comment clears it too", async () => {
    await recurring({ firstCommentDelayMinutes: 30 });
    const id = tables.recurring_schedules[0].id;
    tables.recurring_schedule_targets = [{ recurring_schedule_id: id, social_account_id: "ig" }];
    expect((await request(app()).patch(`/recurring-schedules/${id}`).send({ firstCommentDelayMinutes: 60 })).status).toBe(200);
    expect(tables.recurring_schedules[0].first_comment_delay_minutes).toBe(60);
    expect((await request(app()).patch(`/recurring-schedules/${id}`).send({ firstCommentDelayMinutes: 5000 })).status).toBe(400);
    expect(tables.recurring_schedules[0].first_comment_delay_minutes).toBe(60);
    expect((await request(app()).patch(`/recurring-schedules/${id}`).send({ firstComment: null })).status).toBe(200);
    expect(tables.recurring_schedules[0]).toMatchObject({ first_comment: null, first_comment_delay_minutes: null });
  });

  it("each generated post keeps the delay only on platforms that post first comments", () => {
    const slot = { first_comment: "First!", first_comment_delay_minutes: 30 };
    expect(extrasForPlatform(slot, "instagram", IMG).first_comment_delay_minutes).toBe(30);
    expect(extrasForPlatform(slot, "facebook", IMG).first_comment_delay_minutes).toBe(30);
    expect("first_comment_delay_minutes" in extrasForPlatform(slot, "bluesky", IMG)).toBe(false);
    expect("first_comment_delay_minutes" in extrasForPlatform({ first_comment: "First!" }, "instagram", IMG)).toBe(false);
  });
});
