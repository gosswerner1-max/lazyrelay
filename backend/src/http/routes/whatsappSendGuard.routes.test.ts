// The creation guard: while WhatsApp sending is not built, every path that creates or schedules a post refuses a WhatsApp
// target with HTTP 400, the fixed message and code 'whatsapp_send_not_supported', and creates nothing. One check inside
// validatePostFields covers the single route, bulk import (per row), duplicate and draft promotion; recurring schedules
// have their own check. Login is mocked; supabase is the in-memory fake. Nothing real is touched.

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
const calendarSync = vi.fn(async (_id: string) => {});
vi.mock("../../googleCalendar/outboundSync.js", () => ({ syncPostToCalendar: (id: string) => calendarSync(id), deletePostFromCalendar: async () => {} }));
vi.mock("../../googleSheets/outboundSync.js", () => ({ syncAccountSheet: async () => {} }));
vi.mock("../../urlSafety.js", () => ({ isSafeMediaUrl: async () => ({ safe: true, addresses: ["8.8.8.8"] }) }));

const { buildPostsRouter } = await import("./posts.routes.js");
const { buildRecurringSchedulesRouter } = await import("./recurringSchedules.routes.js");
const { WHATSAPP_SEND_NOT_SUPPORTED_MESSAGE, WHATSAPP_SEND_NOT_SUPPORTED_CODE } = await import("../../platforms/whatsapp/sendSupport.js");

const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildPostsRouter());
  a.use(buildRecurringSchedulesRouter());
  return a;
};
const future = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
const post = (socialAccountId: string, over: Record<string, unknown> = {}) => ({ socialAccountId, content: "Hello", scheduledFor: future(), ...over });
const BLOCKED = { error: WHATSAPP_SEND_NOT_SUPPORTED_MESSAGE, code: WHATSAPP_SEND_NOT_SUPPORTED_CODE };

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  auth.accountId = "acc1";
  calendarSync.mockClear();
  tables.subscriptions = [{ account_id: "acc1", tier: "business", status: "active" }];
  tables.social_accounts = [
    { id: "wa", account_id: "acc1", platform: "whatsapp", platform_account_id: "109876543210987", display_name: "wa", credential_mode: "byok" },
    { id: "tg", account_id: "acc1", platform: "telegram", platform_account_id: "tg1", display_name: "tg" },
    { id: "waOther", account_id: "someone-else", platform: "whatsapp", platform_account_id: "1", display_name: "theirs", credential_mode: "byok" },
  ];
  tables.scheduled_posts = [];
});

describe("POST /scheduled-posts", () => {
  it("refuses a WhatsApp target with 400, the fixed message and code, and creates no row and no calendar event", async () => {
    const r = await request(app()).post("/scheduled-posts").send(post("wa"));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BLOCKED);
    expect(r.body.error).toBe("Not supported yet - requires approved Meta template models");
    expect(tables.scheduled_posts).toHaveLength(0);
    expect(calendarSync).not.toHaveBeenCalled();
  });

  it("refuses it whether the post would be pending or waiting for approval", async () => {
    const r = await request(app()).post("/scheduled-posts").send(post("wa", { requiresApproval: true }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("whatsapp_send_not_supported");
    expect(tables.scheduled_posts).toHaveLength(0);
  });

  it("still creates posts for every other platform", async () => {
    const r = await request(app()).post("/scheduled-posts").send(post("tg"));
    expect(r.status).toBe(201);
    expect(tables.scheduled_posts).toHaveLength(1);
  });

  it("someone else's WhatsApp account is still a 403 (ownership is checked first, nothing is revealed)", async () => {
    const r = await request(app()).post("/scheduled-posts").send(post("waOther"));
    expect(r.status).toBe(403);
  });
});

describe("POST /scheduled-posts/bulk", () => {
  it("creates the non-WhatsApp rows and reports the WhatsApp row per row, in the existing bulk error pattern", async () => {
    const r = await request(app()).post("/scheduled-posts/bulk").send({ posts: [post("tg", { content: "one" }), post("wa", { content: "two" }), post("tg", { content: "three" }), post("wa", { content: "four" })] });
    expect(r.status).toBe(200);
    expect(r.body.succeeded).toBe(2);
    expect(r.body.failed).toBe(2);
    expect(r.body.results.map((x: { row: number; status: number }) => [x.row, x.status])).toEqual([[0, 201], [1, 400], [2, 201], [3, 400]]);
    expect(r.body.results[1].body).toEqual(BLOCKED);
    expect(r.body.results[3].body).toEqual(BLOCKED);
    expect(tables.scheduled_posts.map((p) => p.content).sort()).toEqual(["one", "three"]);
    expect(tables.scheduled_posts.every((p) => p.social_account_id === "tg")).toBe(true);
  });
});

describe("duplicate and draft promotion", () => {
  it("duplicating a post that was written straight to the database against a WhatsApp account is refused, no new row", async () => {
    tables.scheduled_posts = [{ id: "old", account_id: "acc1", social_account_id: "wa", content: "x", status: "failed", media_url: null }];
    const r = await request(app()).post("/scheduled-posts/old/duplicate").send({ scheduledFor: future() });
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BLOCKED);
    expect(tables.scheduled_posts).toHaveLength(1);
  });

  it("promoting a draft onto a WhatsApp account is refused and the draft stays a draft", async () => {
    tables.scheduled_posts = [{ id: "d1", account_id: "acc1", social_account_id: null, content: "x", status: "draft", media_url: null }];
    const r = await request(app()).patch("/scheduled-posts/d1/schedule").send(post("wa"));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BLOCKED);
    expect(tables.scheduled_posts[0]).toMatchObject({ status: "draft", social_account_id: null });
  });

  it("promoting the same draft onto another platform still works", async () => {
    tables.scheduled_posts = [{ id: "d1", account_id: "acc1", social_account_id: null, content: "x", status: "draft", media_url: null }];
    const r = await request(app()).patch("/scheduled-posts/d1/schedule").send(post("tg"));
    expect(r.status).toBe(200);
    expect(tables.scheduled_posts[0]).toMatchObject({ status: "pending", social_account_id: "tg" });
  });
});

describe("recurring schedules", () => {
  const slot = (ids: string[]) => ({ content: "Weekly", socialAccountIds: ids, daysOfWeek: [1], timeOfDay: "09:00", timezone: "UTC" });

  it("creating one with a WhatsApp target is refused with the fixed message and creates nothing", async () => {
    const r = await request(app()).post("/recurring-schedules").send(slot(["tg", "wa"]));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BLOCKED);
    expect(tables.recurring_schedules ?? []).toHaveLength(0);
    expect(tables.recurring_schedule_targets ?? []).toHaveLength(0);
  });

  it("creating one for other platforms still works", async () => {
    const r = await request(app()).post("/recurring-schedules").send(slot(["tg"]));
    expect(r.status).toBe(201);
    expect(tables.recurring_schedule_targets).toHaveLength(1);
  });

  it("editing one to add a WhatsApp target is refused and the targets are unchanged", async () => {
    tables.recurring_schedules = [{ id: "rs1", account_id: "acc1", status: "active", content: "Weekly", first_comment: null, first_comment_delay_minutes: null, tags: [], media_urls: [], options: null }];
    tables.recurring_schedule_targets = [{ id: "t1", recurring_schedule_id: "rs1", social_account_id: "tg" }];
    const r = await request(app()).patch("/recurring-schedules/rs1").send({ socialAccountIds: ["tg", "wa"] });
    expect(r.status).toBe(400);
    expect(r.body).toEqual(BLOCKED);
    expect(tables.recurring_schedule_targets.map((t) => t.social_account_id)).toEqual(["tg"]);
  });
});
