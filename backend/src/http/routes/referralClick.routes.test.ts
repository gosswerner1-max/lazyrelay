// Partner link click counting: always 204, only well-formed codes reach the database, nothing about the visitor is passed on.
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const db = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown>]>, fail: false }));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => f.makeBuilder(t),
      rpc: async (name: string, args: Record<string, unknown>) => {
        db.calls.push([name, args]);
        return { data: null, error: db.fail ? { message: "boom" } : null };
      },
    },
  };
});
vi.mock("../../email.js", () => ({ sendReviewFeedbackNotification: () => {}, sendNewsletterWelcomeEmail: () => {}, sendReferralApplicationNotification: () => {} }));

const { buildPublicRouter } = await import("./public.routes.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildPublicRouter());
  return a;
};

beforeEach(() => {
  db.calls = [];
  db.fail = false;
});

describe("POST /public/referral/click", () => {
  it("counts a click with the code and channel and answers 204", async () => {
    const res = await request(app()).post("/public/referral/click").send({ code: "Sarah", channel: "YouTube" });
    expect(res.status).toBe(204);
    expect(db.calls).toEqual([["record_referral_click", { p_code: "sarah", p_channel: "youtube" }]]);
  });
  it("works without a channel", async () => {
    await request(app()).post("/public/referral/click").send({ code: "sarah" });
    expect(db.calls[0][1]).toEqual({ p_code: "sarah", p_channel: "" });
  });
  it("answers 204 for junk and never touches the database", async () => {
    for (const body of [{}, { code: "" }, { code: "a b" }, { code: "x".repeat(41) }, { code: "sarah", channel: "You Tube" }, { code: "sarah", channel: "a".repeat(31) }, { code: 5 }, { code: "';drop table accounts;--" }]) {
      const res = await request(app()).post("/public/referral/click").send(body);
      expect(res.status).toBe(204);
    }
    expect(db.calls).toHaveLength(0);
  });
  it("answers 204 even when the database call fails, so a visitor never sees an error", async () => {
    db.fail = true;
    const res = await request(app()).post("/public/referral/click").send({ code: "sarah" });
    expect(res.status).toBe(204);
  });
  it("passes on nothing but the code and the channel (no ip, no headers, no user agent)", async () => {
    await request(app()).post("/public/referral/click").set("User-Agent", "Mozilla/5.0 X").set("X-Forwarded-For", "203.0.113.9").send({ code: "sarah" });
    expect(Object.keys(db.calls[0][1]).sort()).toEqual(["p_channel", "p_code"]);
  });
});
