// The scheduling-time TikTok heads-up: TikTok's guidelines say about 15 API posts a day per
// creator account is typical (varies, shared across apps), so a 16th post in 24 hours gets a
// warning in the response and nothing else changes. supabase is an in-memory fake.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

let failReadsOn: string | null = null;
vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => {
        const b = f.makeBuilder(t) as Record<string, (...a: unknown[]) => unknown>;
        if (t !== failReadsOn) return b;
        const realSelect = b.select;
        b.select = (...a: unknown[]) => {
          const chain = realSelect(...a) as Record<string, unknown>;
          chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve);
          return chain;
        };
        return b;
      },
    },
  };
});
vi.mock("./googleCalendar/outboundSync.js", () => ({ syncPostToCalendar: vi.fn(async () => {}) }));
vi.mock("./googleSheets/outboundSync.js", () => ({ syncAccountSheet: vi.fn(async () => {}) }));

const { checkTiktokDailyWarning, checkSchedulingWarnings, TIKTOK_DAILY_TYPICAL_MESSAGE, TIKTOK_TYPICAL_DAILY_POSTS } = await import("./postCreation.js");

const HOUR = 60 * 60 * 1000;
const BASE = new Date("2026-11-10T08:00:00.000Z").getTime();
const ACCOUNT = "tt1";

const seed = (count: number, over: Record<string, unknown> = {}) => {
  tables.scheduled_posts = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    social_account_id: ACCOUNT,
    status: "pending",
    paused_at: null,
    recurring_schedule_id: null,
    scheduled_for: new Date(BASE + i * 10 * 60_000).toISOString(),
    ...over,
  }));
};
const newRow = () => ({ id: "new", social_account_id: ACCOUNT, scheduled_for: new Date(BASE + 5 * HOUR).toISOString() });
const withNew = () => {
  tables.scheduled_posts = [...(tables.scheduled_posts as unknown[]), newRow()];
};

beforeEach(() => {
  failReadsOn = null;
  tables.scheduled_posts = [];
});

describe("checkTiktokDailyWarning", () => {
  it("uses TikTok's documented typical number", () => {
    expect(TIKTOK_TYPICAL_DAILY_POSTS).toBe(15);
  });

  it("stays quiet at 15 posts in the day (the 15th is still typical)", async () => {
    seed(14);
    withNew();
    expect(await checkTiktokDailyWarning({ platform: "tiktok", row: newRow() })).toEqual([]);
  });

  it("warns on the 16th post in 24 hours, and says it is only a heads-up", async () => {
    seed(15);
    withNew();
    const w = await checkTiktokDailyWarning({ platform: "tiktok", row: newRow() });
    expect(w).toEqual([{ code: "tiktok_daily_typical", message: TIKTOK_DAILY_TYPICAL_MESSAGE }]);
    expect(w[0].message).toMatch(/scheduled/);
    expect(w[0].message).toMatch(/varies/);
  });

  it("never warns for another platform, however many posts", async () => {
    seed(40);
    withNew();
    expect(await checkTiktokDailyWarning({ platform: "instagram", row: newRow() })).toEqual([]);
  });

  it("does not count paused or failed posts", async () => {
    seed(15, { paused_at: "2026-11-01T00:00:00.000Z" });
    withNew();
    expect(await checkTiktokDailyWarning({ platform: "tiktok", row: newRow() })).toEqual([]);
    seed(15, { status: "failed" });
    withNew();
    expect(await checkTiktokDailyWarning({ platform: "tiktok", row: newRow() })).toEqual([]);
  });

  it("does not count posts on a different TikTok account", async () => {
    seed(15, { social_account_id: "other" });
    withNew();
    expect(await checkTiktokDailyWarning({ platform: "tiktok", row: newRow() })).toEqual([]);
  });

  it("does not count posts more than a day away", async () => {
    tables.scheduled_posts = Array.from({ length: 20 }, (_, i) => ({
      id: `far${i}`, social_account_id: ACCOUNT, status: "pending", paused_at: null, recurring_schedule_id: null,
      scheduled_for: new Date(BASE - 3 * 24 * HOUR + i * 60_000).toISOString(),
    }));
    withNew();
    expect(await checkTiktokDailyWarning({ platform: "tiktok", row: newRow() })).toEqual([]);
  });

  it("fails open: a failed lookup means no warning, never an error", async () => {
    seed(20);
    withNew();
    failReadsOn = "scheduled_posts";
    expect(await checkTiktokDailyWarning({ platform: "tiktok", row: newRow() })).toEqual([]);
  });

  it("is merged with the Pinterest heads-up by checkSchedulingWarnings", async () => {
    seed(15);
    withNew();
    const w = await checkSchedulingWarnings({ platform: "tiktok", row: newRow(), content: "hello" });
    expect(w.map((x) => x.code)).toEqual(["tiktok_daily_typical"]);
  });
});
