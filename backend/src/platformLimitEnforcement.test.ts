// Behavior tests for the DB-touching halves of the Pinterest rolling-24h cap:
// checkPlatformPostLimit (every scheduled_for writer), dropRowsOverPlatformLimit
// (recurring generation) and getPlatformLimitDeferral (scheduler backstop).
// supabase is replaced with an in-memory fake, so nothing here can reach a
// real database or platform. The pure window maths has its own tests in
// platformPostLimits.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

interface Call {
  table: string;
  ops: Array<[string, unknown[]]>;
}
const calls: Call[] = [];
let respond: (call: Call) => { data: unknown; error: { message: string } | null } = () => ({ data: [], error: null });

// A chainable, awaitable stand-in for supabase's query builder: every method
// records itself and returns the builder; awaiting it resolves via `respond`.
function makeBuilder(table: string) {
  const call: Call = { table, ops: [] };
  calls.push(call);
  const builder: Record<string, unknown> = {};
  for (const op of ["select", "eq", "in", "is", "gt", "lt", "lte", "neq", "not", "update"]) {
    builder[op] = (...args: unknown[]) => {
      call.ops.push([op, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(respond(call)).then(resolve, reject);
  return builder;
}

vi.mock("./supabase.js", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

// The modules under test read PINTEREST_DAILY_POST_LIMIT once at import
// time; pin it to the documented default so a value in a local .env can't
// change what these tests mean.
delete process.env.PINTEREST_DAILY_POST_LIMIT;

const { checkPlatformPostLimit } = await import("./postCreation.js");
const { dropRowsOverPlatformLimit } = await import("./recurringScheduler.js");
const { getPlatformLimitDeferral } = await import("./scheduler.js");

const HOUR = 60 * 60 * 1000;
const BASE = Date.UTC(2026, 8, 21, 0, 0, 0);
const at = (hours: number) => new Date(BASE + hours * HOUR);
const iso = (hours: number) => at(hours).toISOString();
const rows = (n: number, startHour: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, scheduled_for: iso(startHour + i), recurring_schedule_id: null, ...extra }));

beforeEach(() => {
  calls.length = 0;
  respond = () => ({ data: [], error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("checkPlatformPostLimit", () => {
  it("never queries and never blocks a platform with no cap", async () => {
    const result = await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "tiktok", scheduledFor: at(5) });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("allows a Pinterest post when the account is under the limit", async () => {
    respond = () => ({ data: rows(9, 0), error: null });
    const result = await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "pinterest", scheduledFor: at(10) });
    expect(result).toBeNull();
  });

  it("returns 422 platform_daily_limit with the next free time when the day is full", async () => {
    respond = () => ({ data: rows(10, 0), error: null }); // hours 0..9
    const result = await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "pinterest", scheduledFor: at(10) });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(422);
    expect(result!.body).toEqual({
      error: "Pinterest allows up to 10 pins a day per account, and that day is full. The next free time is September 22, 2026 at 00:00 UTC.",
      code: "platform_daily_limit",
      platform: "pinterest",
      limit: 10,
      nextAvailable: iso(24),
    });
  });

  it("counts only live, unpaused statuses of that social account, and excludes the moved post", async () => {
    await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "pinterest", scheduledFor: at(10), excludePostId: "self" });
    const ops = calls[0].ops;
    expect(calls[0].table).toBe("scheduled_posts");
    expect(ops).toContainEqual(["eq", ["social_account_id", "sa1"]]);
    expect(ops).toContainEqual(["in", ["status", ["pending", "posting", "posted", "needs_approval"]]]);
    expect(ops).toContainEqual(["is", ["paused_at", null]]);
    expect(ops).toContainEqual(["neq", ["id", "self"]]);
  });

  it("looks only at the 24h either side of the requested time", async () => {
    await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "pinterest", scheduledFor: at(30) });
    const ops = calls[0].ops;
    expect(ops).toContainEqual(["gt", ["scheduled_for", iso(6)]]);
    expect(ops).toContainEqual(["lt", ["scheduled_for", iso(54)]]);
  });

  it("fails closed with a 500 (not a pass) when the count query errors", async () => {
    respond = () => ({ data: null, error: { message: "boom" } });
    const result = await checkPlatformPostLimit({ socialAccountId: "sa1", platform: "pinterest", scheduledFor: at(10) });
    expect(result?.status).toBe(500);
    expect(String(result?.body.error)).not.toContain("boom");
  });
});

describe("dropRowsOverPlatformLimit (recurring generation)", () => {
  const occ = (socialAccountId: string, hours: number) => ({ social_account_id: socialAccountId, scheduled_for: iso(hours) });
  const platforms = new Map([
    ["pin", "pinterest"],
    ["tt", "tiktok"],
  ]);

  it("passes rows for platforms without a cap straight through, with no query", async () => {
    const input = [occ("tt", 1), occ("tt", 2)];
    const result = await dropRowsOverPlatformLimit("slot1", input, platforms);
    expect(result).toEqual(input);
    expect(calls).toHaveLength(0);
  });

  it("skips the occurrence that would go over and keeps the ones that fit, without throwing", async () => {
    respond = () => ({ data: rows(9, 0), error: null }); // 9 existing at hours 0..8
    const result = await dropRowsOverPlatformLimit("slot1", [occ("pin", 10), occ("pin", 11)], platforms);
    expect(result).toEqual([occ("pin", 10)]); // the 10th fits, the 11th does not
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("counts earlier accepted occurrences in the same run against later ones", async () => {
    const result = await dropRowsOverPlatformLimit(
      "slot1",
      Array.from({ length: 12 }, (_, i) => occ("pin", i)),
      platforms,
    );
    expect(result).toHaveLength(10);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("keeps an occurrence this slot already materialized instead of counting it against itself", async () => {
    // Account is already at the limit, and one of those 10 rows IS this
    // slot's own earlier occurrence at hour 9.
    respond = () => ({
      data: [...rows(9, 0), { id: "own", scheduled_for: iso(9), recurring_schedule_id: "slot1" }],
      error: null,
    });
    const result = await dropRowsOverPlatformLimit("slot1", [occ("pin", 9)], platforms);
    expect(result).toEqual([occ("pin", 9)]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("fails closed for one account on a lookup error but still returns other platforms' rows", async () => {
    respond = () => ({ data: null, error: { message: "boom" } });
    const result = await dropRowsOverPlatformLimit("slot1", [occ("pin", 1), occ("tt", 1)], platforms);
    expect(result).toEqual([occ("tt", 1)]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("getPlatformLimitDeferral (scheduler backstop)", () => {
  const post = (platform: string) => ({ id: "due1", social_account_id: "sa1", platform }) as unknown as Parameters<typeof getPlatformLimitDeferral>[0];

  it("does nothing for a platform with no cap, without querying", async () => {
    expect(await getPlatformLimitDeferral(post("mastodon"))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("lets the post go when fewer than the limit went out in the last 24h", async () => {
    const now = Date.now();
    respond = () => ({ data: Array.from({ length: 9 }, (_, i) => ({ scheduled_for: new Date(now - (i + 1) * HOUR).toISOString() })), error: null });
    expect(await getPlatformLimitDeferral(post("pinterest"))).toBeNull();
  });

  it("defers to when the oldest post in the window ages out once the limit is reached", async () => {
    const now = Date.now();
    const oldest = now - 20 * HOUR;
    respond = () => ({
      data: Array.from({ length: 10 }, (_, i) => ({ scheduled_for: new Date(oldest + i * HOUR).toISOString() })),
      error: null,
    });
    const deferral = await getPlatformLimitDeferral(post("pinterest"));
    expect(deferral).not.toBeNull();
    expect(deferral!.getTime()).toBe(oldest + 24 * HOUR);
  });

  it("only looks at posted/posting posts of this account, other than itself, up to now", async () => {
    await getPlatformLimitDeferral(post("pinterest"));
    const ops = calls[0].ops;
    expect(ops).toContainEqual(["eq", ["social_account_id", "sa1"]]);
    expect(ops).toContainEqual(["in", ["status", ["posted", "posting"]]]);
    expect(ops).toContainEqual(["neq", ["id", "due1"]]);
    expect(ops.map(([op]) => op)).toContain("lte");
  });

  it("fails open (sends) on a lookup error instead of turning it into a failure", async () => {
    respond = () => ({ data: null, error: { message: "boom" } });
    expect(await getPlatformLimitDeferral(post("pinterest"))).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
