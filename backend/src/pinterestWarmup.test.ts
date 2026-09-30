// Pinterest warm-up ramp: a NEW Pinterest connection is eased in (1 pin a day
// the first week, then 2, then 3, then the normal 10). Pure ramp maths, the
// account lookup, and the real scheduling checks that enforce it. supabase is an
// in-memory fake.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});

const { pinterestLimitForAge, platformLimitMessage, PINTEREST_WARMUP_DAYS } = await import("./platformPostLimits.js");
const { effectiveLimitAt, resolvePostLimitAt } = await import("./pinterestWarmup.js");
const { checkPlatformPostLimit } = await import("./postCreation.js");
const { getPlatformLimitDeferral } = await import("./scheduler.js");
const { dropRowsOverPlatformLimit } = await import("./recurringScheduler.js");

const DAY = 86_400_000;
const CONNECTED = new Date(Date.UTC(2026, 9, 1, 8, 0, 0)); // 1 Oct 2026 08:00 UTC
const at = (days: number, hours = 0) => new Date(CONNECTED.getTime() + days * DAY + hours * 3_600_000);

describe("pinterestLimitForAge (the ramp)", () => {
  it.each([
    [0, 1], [3, 1], [6, 1],   // first week: 1 a day
    [7, 2], [9, 2],           // then 2
    [10, 3], [13, 3],         // then 3
    [14, 10], [40, 10],       // about two weeks in: the normal cap
  ])("age %s days -> %s pins a day", (age, expected) => {
    const r = pinterestLimitForAge(10, CONNECTED, false, at(age, 2));
    expect(r.limit).toBe(expected);
    expect(r.warmingUp).toBe(expected !== 10);
  });

  it("reports when the ramp ends", () => {
    const r = pinterestLimitForAge(10, CONNECTED, false, at(2));
    expect(r.warmupEndsAt?.toISOString()).toBe(at(PINTEREST_WARMUP_DAYS).toISOString());
    expect(pinterestLimitForAge(10, CONNECTED, false, at(20)).warmupEndsAt).toBeNull();
  });

  it("an account the customer confirmed as already warmed up skips the ramp", () => {
    expect(pinterestLimitForAge(10, CONNECTED, true, at(0)).limit).toBe(10);
  });

  it("never lets a ramp step exceed a lower normal cap", () => {
    expect(pinterestLimitForAge(2, CONNECTED, false, at(11)).limit).toBe(2);
  });

  it("an unknown connection date is treated as an established account", () => {
    expect(pinterestLimitForAge(10, null, false, at(0)).limit).toBe(10);
  });
});

describe("effectiveLimitAt", () => {
  const fresh = { connectedAt: CONNECTED, confirmed: false };

  it("only Pinterest is ramped; other platforms are untouched", () => {
    expect(effectiveLimitAt("pinterest", fresh, at(1))?.limit).toBe(1);
    expect(effectiveLimitAt("facebook", fresh, at(1))).toBeNull(); // no cap of its own
  });

  it("the kill switch turns the ramp off without a deploy", () => {
    process.env.PINTEREST_WARMUP_RAMP = "off";
    try {
      expect(effectiveLimitAt("pinterest", fresh, at(1))?.limit).toBe(10);
    } finally {
      delete process.env.PINTEREST_WARMUP_RAMP;
    }
  });
});

describe("the warm-up message", () => {
  it("says the account is warming up, the daily number, when it rises, and the next free time", () => {
    const m = platformLimitMessage("pinterest", 1, at(1), { fullLimit: 10, warmupEndsAt: at(14) });
    expect(m).toMatch(/still warming up/);
    expect(m).toMatch(/allows 1 pin a day for now/);
    expect(m).toMatch(/rises to 10 pins a day from October 15, 2026/);
    expect(m).toMatch(/next free time is October 2, 2026/);
    expect(m).not.toMatch(/[–—]/); // no en or em dashes
  });

  it("the normal-cap message is unchanged", () => {
    expect(platformLimitMessage("pinterest", 10, at(1))).toBe(
      "Pinterest allows up to 10 pins a day per account, and that day is full. The next free time is October 2, 2026 at 08:00 UTC.",
    );
  });
});

function seedAccount(over: Record<string, unknown> = {}) {
  tables.social_accounts = [{ id: "sa1", platform: "pinterest", connected_at: CONNECTED.toISOString(), pinterest_warmup_confirmed_at: null, ...over }];
  tables.scheduled_posts = [];
}
function addPost(when: Date, over: Record<string, unknown> = {}) {
  tables.scheduled_posts.push({ id: `p${tables.scheduled_posts.length + 1}`, social_account_id: "sa1", status: "pending", paused_at: null, scheduled_for: when.toISOString(), recurring_schedule_id: null, ...over });
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("resolvePostLimitAt", () => {
  it("reads the account and applies the ramp", async () => {
    seedAccount();
    expect((await resolvePostLimitAt("sa1", "pinterest", at(1)))?.limit).toBe(1);
  });

  it("a confirmed (or grandfathered) account gets the normal cap", async () => {
    seedAccount({ pinterest_warmup_confirmed_at: CONNECTED.toISOString() });
    expect((await resolvePostLimitAt("sa1", "pinterest", at(1)))?.limit).toBe(10);
  });

  it("an account row that cannot be found fails open to the normal cap", async () => {
    tables.social_accounts = [];
    expect((await resolvePostLimitAt("missing", "pinterest", at(1)))?.limit).toBe(10);
  });
});

describe("checkPlatformPostLimit enforces the ramp when scheduling", () => {
  it("a brand-new account can schedule 1 pin on day 2, but not a second the same day", async () => {
    seedAccount();
    expect(await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "pinterest", scheduledFor: at(1, 2) })).toBeNull();
    addPost(at(1, 2));
    const blocked = await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "pinterest", scheduledFor: at(1, 6) });
    expect(blocked?.status).toBe(422);
    expect(blocked?.body).toMatchObject({ code: "platform_daily_limit", warmingUp: true, limit: 1, fullLimit: 10 });
    expect(String(blocked?.body.error)).toMatch(/still warming up/);
  });

  it("the allowance steps up with the account's age at the time of the post", async () => {
    seedAccount();
    addPost(at(8, 1));
    expect(await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "pinterest", scheduledFor: at(8, 3) })).toBeNull(); // day 8 allows 2
    addPost(at(8, 3));
    expect((await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "pinterest", scheduledFor: at(8, 5) }))?.status).toBe(422);
  });

  it("a post scheduled for after the ramp ends gets the normal cap even from a new account", async () => {
    seedAccount();
    for (let i = 0; i < 9; i++) addPost(at(20, i));
    expect(await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "pinterest", scheduledFor: at(20, 12) })).toBeNull(); // 10th
  });

  it("an account confirmed as warmed up is not slowed down", async () => {
    seedAccount({ pinterest_warmup_confirmed_at: CONNECTED.toISOString() });
    for (let i = 0; i < 9; i++) addPost(at(1, i));
    expect(await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "pinterest", scheduledFor: at(1, 12) })).toBeNull();
  });
});

describe("the send-time backstop and recurring schedules follow the same ramp", () => {
  it("defers a second pin from a brand-new account at send time", async () => {
    seedAccount({ connected_at: new Date(Date.now() - 2 * DAY).toISOString() });
    addPost(new Date(Date.now() - 3_600_000), { status: "posted" }); // one already went out today
    const deferral = await getPlatformLimitDeferral({ id: "p-new", social_account_id: "sa1", platform: "pinterest" } as never);
    expect(deferral).toBeInstanceOf(Date);
  });

  it("does not defer an established account with the same history", async () => {
    seedAccount({ connected_at: new Date(Date.now() - 2 * DAY).toISOString(), pinterest_warmup_confirmed_at: new Date().toISOString() });
    addPost(new Date(Date.now() - 3_600_000), { status: "posted" });
    expect(await getPlatformLimitDeferral({ id: "p-new", social_account_id: "sa1", platform: "pinterest" } as never)).toBeNull();
  });

  it("recurring generation keeps only the occurrences the ramp allows", async () => {
    seedAccount();
    const rows = [
      { social_account_id: "sa1", scheduled_for: at(1, 1).toISOString() },
      { social_account_id: "sa1", scheduled_for: at(1, 5).toISOString() }, // second pin on a 1-a-day day
      { social_account_id: "sa1", scheduled_for: at(3, 1).toISOString() }, // a new day, fine
    ];
    const kept = await dropRowsOverPlatformLimit("slot1", rows, new Map([["sa1", "pinterest"]]));
    expect(kept.map((r) => r.scheduled_for)).toEqual([at(1, 1).toISOString(), at(3, 1).toISOString()]);
  });
});
