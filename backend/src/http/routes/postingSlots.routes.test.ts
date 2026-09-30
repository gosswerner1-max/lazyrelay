// Posting slots API and next-free-slot. Login mocked; supabase is the in-memory fake.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

const auth = vi.hoisted(() => ({ accountId: "acc1" }));
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

const { buildPostingSlotsRouter, MAX_POSTING_SLOTS } = await import("./postingSlots.routes.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use(buildPostingSlotsRouter());
  return a;
};
const slot = { daysOfWeek: [1, 3, 5], timeOfDay: "09:00", timezone: "Africa/Johannesburg" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T08:00:00Z"));
  for (const k of Object.keys(tables)) delete tables[k];
  tables.social_accounts = [
    { id: "sa1", account_id: "acc1" },
    { id: "sa2", account_id: "acc2" },
  ];
  auth.accountId = "acc1";
});
afterEach(() => vi.useRealTimers());

describe("posting slots", () => {
  it("adds, lists and deletes a posting time", async () => {
    const created = await request(app()).post("/posting-slots").send(slot);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject(slot);
    expect((await request(app()).get("/posting-slots")).body.slots).toHaveLength(1);
    expect((await request(app()).delete(`/posting-slots/${created.body.id}`)).body).toEqual({ deleted: true });
    expect((await request(app()).get("/posting-slots")).body.slots).toHaveLength(0);
  });

  it("refuses a bad time, day or timezone", async () => {
    expect((await request(app()).post("/posting-slots").send({ ...slot, timeOfDay: "9am" })).status).toBe(400);
    expect((await request(app()).post("/posting-slots").send({ ...slot, daysOfWeek: [] })).status).toBe(400);
    expect((await request(app()).post("/posting-slots").send({ ...slot, daysOfWeek: [8] })).status).toBe(400);
    expect((await request(app()).post("/posting-slots").send({ ...slot, timezone: "Nowhere/Land" })).status).toBe(400);
  });

  it("stops at the limit", async () => {
    tables.posting_slots = Array.from({ length: MAX_POSTING_SLOTS }, (_, i) => ({ id: `p${i}`, account_id: "acc1", days_of_week: [1], time_of_day: "09:00", timezone: "UTC" }));
    expect((await request(app()).post("/posting-slots").send(slot)).status).toBe(400);
  });

  it("never touches another account's times", async () => {
    tables.posting_slots = [{ id: "theirs", account_id: "acc2", days_of_week: [1], time_of_day: "09:00", timezone: "UTC" }];
    expect((await request(app()).get("/posting-slots")).body.slots).toHaveLength(0);
    expect((await request(app()).delete("/posting-slots/theirs")).status).toBe(404);
  });
});

describe("GET /posting-slots/next", () => {
  it("needs a channel that belongs to the caller", async () => {
    expect((await request(app()).get("/posting-slots/next")).status).toBe(400);
    expect((await request(app()).get("/posting-slots/next?socialAccountId=sa2")).status).toBe(404);
  });

  it("explains when no times are saved", async () => {
    const r = await request(app()).get("/posting-slots/next?socialAccountId=sa1");
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/No posting times saved/);
  });

  it("returns the next free time, skipping ones this channel already uses", async () => {
    await request(app()).post("/posting-slots").send(slot);
    let r = await request(app()).get("/posting-slots/next?socialAccountId=sa1");
    expect(r.body.scheduledFor).toBe("2026-10-02T07:00:00.000Z");
    tables.scheduled_posts = [
      { id: "p1", account_id: "acc1", social_account_id: "sa1", status: "pending", scheduled_for: "2026-10-02T07:00:00.000Z" },
      // another channel and a finished post must not block the slot
      { id: "p2", account_id: "acc1", social_account_id: "sa2", status: "pending", scheduled_for: "2026-10-05T07:00:00.000Z" },
      { id: "p3", account_id: "acc1", social_account_id: "sa1", status: "posted", scheduled_for: "2026-10-05T07:00:00.000Z" },
    ];
    r = await request(app()).get("/posting-slots/next?socialAccountId=sa1");
    expect(r.body.scheduledFor).toBe("2026-10-05T07:00:00.000Z");
  });
});
