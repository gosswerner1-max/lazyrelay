// The partner application form: the vetting answers are validated and reach the
// notification email; an older cached form without them still works.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const mail = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});
vi.mock("../../email.js", () => ({
  sendReviewFeedbackNotification: () => {},
  sendNewsletterWelcomeEmail: () => {},
  sendReferralApplicationNotification: (...args: unknown[]) => mail.calls.push(args),
}));

const { buildPublicRouter } = await import("./public.routes.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildPublicRouter());
  return a;
};
const base = { name: "Sam", channel: "@sam", platform: "YouTube", email: "sam@example.org" };
const full = { ...base, channelLink: "https://youtube.com/@sam", audienceSize: "12,000 subscribers", audienceCountries: "South Africa", preferredPlan: "A", howPromote: "A video review" };

beforeEach(() => {
  mail.calls = [];
});

describe("POST /public/referral/apply", () => {
  it("passes the vetting answers to the notification email", async () => {
    const res = await request(app()).post("/public/referral/apply").send(full);
    expect(res.status).toBe(200);
    expect(mail.calls).toHaveLength(1);
    expect(mail.calls[0][5]).toEqual({
      channelLink: "https://youtube.com/@sam",
      audienceSize: "12,000 subscribers",
      audienceCountries: "South Africa",
      preferredPlan: "A",
      howPromote: "A video review",
    });
  });

  it("still accepts an older form that sends none of the new answers", async () => {
    const res = await request(app()).post("/public/referral/apply").send(base);
    expect(res.status).toBe(200);
    expect(mail.calls[0][5]).toEqual({ channelLink: null, audienceSize: null, audienceCountries: null, preferredPlan: null, howPromote: null });
  });

  it("rejects a channel link that is not a web address", async () => {
    const res = await request(app()).post("/public/referral/apply").send({ ...full, channelLink: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect(mail.calls).toHaveLength(0);
  });

  it("rejects an unknown plan", async () => {
    const res = await request(app()).post("/public/referral/apply").send({ ...full, preferredPlan: "C" });
    expect(res.status).toBe(400);
    expect(mail.calls).toHaveLength(0);
  });
});
