// The platform's original error text (post_results.raw_error_message) is kept for operations but never returned to a customer.
// The friendly error_message and every other result field still come back untouched. Login is mocked, supabase is the in-memory fake.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

vi.mock("../auth.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.accountId = "acc1";
      // the in-memory fake has no .range(); one page is enough for these few rows
      req.db = { from: (t: string) => Object.assign(f.makeBuilder(t), { range: function (this: any, _from: number, to: number) { return this.limit(to + 1); } }) };
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

const { buildPostsRouter } = await import("./posts.routes.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildPostsRouter());
  return a;
};

const RAW = "OAuthException: token EAAFakeTokenForTests0123456789 expired";
const result = { error_message: "The platform said no.", raw_error_message: RAW, verified_live: false, platform_post_url: null };

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.subscriptions = [{ account_id: "acc1", tier: "business", status: "active" }];
  tables.scheduled_posts = [
    { id: "p1", account_id: "acc1", status: "failed", scheduled_for: "2026-10-01T09:00:00Z", created_at: "2026-09-30T09:00:00Z", content: "a", post_results: [{ ...result }] },
    { id: "p2", account_id: "acc1", status: "pending", scheduled_for: "2026-12-01T09:00:00Z", created_at: "2026-09-30T09:00:00Z", content: "b", post_results: [{ ...result }] },
  ];
});

describe("customer post lists never carry the platform's raw error text", () => {
  for (const path of ["/scheduled-posts", "/scheduled-posts/history"]) {
    it(`GET ${path} strips raw_error_message and keeps the rest`, async () => {
      const r = await request(app()).get(path);
      expect(r.status).toBe(200);
      expect(r.text).not.toContain("raw_error_message");
      expect(r.text).not.toContain("EAAFakeToken");
      const failed = r.body.find((p: { id: string }) => p.id === "p1");
      expect(failed.post_results[0]).toEqual({ error_message: "The platform said no.", verified_live: false, platform_post_url: null });
    });
  }

  it("the stored row still holds the raw text for operations", async () => {
    await request(app()).get("/scheduled-posts");
    expect((tables.scheduled_posts[0].post_results as Array<Record<string, unknown>>)[0].raw_error_message).toBe(RAW);
  });
});
