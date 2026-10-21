// Date and grouping logic behind the Calendar workspace. Pure functions; every date is built in local time so the tests hold in any time zone.
import { describe, it, expect, vi } from "vitest";
import { startOfWeek, weekDays, monthMatrix, monthLabel, weekLabel, shiftAnchor, postsByDay, dayStats, googleSyncByDay, PER_DAY_CARDS } from "./calendarModel";
import type { ScheduledPost, SocialAccount } from "./api";

// dashboardHelpers (used for the brand filter) pulls in the API client, which needs a database address to start.
vi.mock("./api", () => ({}));

const local = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm);
const key = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("weeks", () => {
  it("a week starts on Monday and runs seven days", () => {
    // Wed 11 March 2026
    expect(startOfWeek(local(2026, 3, 11))).toEqual(local(2026, 3, 9));
    expect(startOfWeek(local(2026, 3, 9))).toEqual(local(2026, 3, 9));
    expect(startOfWeek(local(2026, 3, 15))).toEqual(local(2026, 3, 9)); // Sunday belongs to the week that began Monday
    expect(weekDays(local(2026, 3, 11))).toEqual([9, 10, 11, 12, 13, 14, 15].map((d) => key(2026, 3, d)));
  });
  it("a week that crosses a month end keeps counting into the next month", () => {
    expect(weekDays(local(2026, 3, 31))).toEqual([key(2026, 3, 30), key(2026, 3, 31), key(2026, 4, 1), key(2026, 4, 2), key(2026, 4, 3), key(2026, 4, 4), key(2026, 4, 5)]);
  });
});

describe("month matrix", () => {
  it("starts on the Monday on or before the 1st and ends on the Sunday on or after the last day", () => {
    const m = monthMatrix(local(2026, 3, 20)); // 1 March 2026 is a Sunday
    expect(m[0]).toBe(key(2026, 2, 23));
    expect(m[m.length - 1]).toBe(key(2026, 4, 5));
    expect(m.length % 7).toBe(0);
    expect(m.length).toBe(42); // six rows
  });
  it("uses five rows when the month fits", () => {
    const m = monthMatrix(local(2026, 2, 10)); // February 2026 starts on a Sunday... 1 Feb 2026 is a Sunday: six rows needed
    expect([35, 42]).toContain(m.length);
    const june = monthMatrix(local(2026, 6, 10)); // 1 June 2026 is a Monday and June has 30 days: five rows
    expect(june.length).toBe(35);
    expect(june[0]).toBe(key(2026, 6, 1));
  });
});

describe("labels and navigation", () => {
  it("labels the month and the week", () => {
    expect(monthLabel(local(2026, 3, 20))).toBe("March 2026");
    expect(weekLabel(local(2026, 3, 11))).toBe("Mon 9 to Sun 15 Mar 2026");
    expect(weekLabel(local(2026, 3, 31))).toBe("Mon 30 Mar to Sun 5 Apr 2026");
  });
  it("moves a week or a month at a time, without drifting off the 31st", () => {
    expect(shiftAnchor(local(2026, 3, 11), "week", 1)).toEqual(local(2026, 3, 18));
    expect(shiftAnchor(local(2026, 3, 11), "week", -1)).toEqual(local(2026, 3, 4));
    expect(shiftAnchor(local(2026, 1, 31), "month", 1)).toEqual(local(2026, 2, 1));
    expect(shiftAnchor(local(2026, 3, 11), "month", -1)).toEqual(local(2026, 2, 1));
  });
});

const acct = (id: string, platform: string, brand: string | null): SocialAccount => ({ id, platform, platform_account_id: id, display_name: id, connected_at: "2026-01-01T00:00:00Z", brand_label: brand, brand_id: null });
const ACCOUNTS = [acct("a1", "tiktok", "Alpha"), acct("a2", "facebook", "Alpha"), acct("b1", "facebook", "Beta")];
const post = (id: string, status: ScheduledPost["status"], accountId: string | null, when: Date | null, extra: Record<string, unknown> = {}): ScheduledPost =>
  ({ id, status, social_account_id: accountId, scheduled_for: when ? when.toISOString() : null, planned_date: null, paused_at: null, google_event_id: null, content: "text " + id, ...extra }) as unknown as ScheduledPost;
const POSTS = [
  post("p2", "pending", "a2", local(2026, 3, 11, 14, 0), { paused_at: "2026-03-01T00:00:00Z" }),
  post("p1", "posted", "a1", local(2026, 3, 11, 9, 0), { google_event_id: "g1" }),
  post("p3", "pending", "b1", local(2026, 3, 11, 16, 30), { google_event_id: "g3" }),
  post("p4", "failed", "a1", local(2026, 3, 12, 8, 0)),
  post("p5", "draft", null, null, { planned_date: "2026-03-12" }),
  post("p6", "draft", null, null),
];

describe("postsByDay", () => {
  it("groups by local day and sorts each day by time", () => {
    const map = postsByDay(POSTS, ACCOUNTS, "");
    expect(map.get("2026-03-11")!.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(map.get("2026-03-12")!.map((p) => p.id)).toEqual(["p5", "p4"]); // a planned draft has no time, so it sorts first
  });
  it("leaves out drafts that have no day yet", () => {
    const all = [...postsByDay(POSTS, ACCOUNTS, "").values()].flat();
    expect(all.map((p) => p.id)).not.toContain("p6");
  });
  it("follows the brand filter", () => {
    const alpha = postsByDay(POSTS, ACCOUNTS, "Alpha");
    expect(alpha.get("2026-03-11")!.map((p) => p.id)).toEqual(["p1", "p2"]);
    const beta = postsByDay(POSTS, ACCOUNTS, "Beta");
    expect(beta.get("2026-03-11")!.map((p) => p.id)).toEqual(["p3"]);
  });
});

describe("dayStats", () => {
  it("counts published, paused, scheduled, failed and drafts separately", () => {
    const day = postsByDay(POSTS, ACCOUNTS, "").get("2026-03-11")!;
    expect(dayStats(day)).toEqual({ total: 3, published: 1, paused: 1, scheduled: 1, failed: 0, drafts: 0 });
    expect(dayStats(postsByDay(POSTS, ACCOUNTS, "").get("2026-03-12")!)).toEqual({ total: 2, published: 0, paused: 0, scheduled: 0, failed: 1, drafts: 1 });
  });
});

describe("googleSyncByDay", () => {
  it("counts, for each day asked about, the posts that came from a Google Calendar event", () => {
    const days = ["2026-03-10", "2026-03-11", "2026-03-12"];
    expect(googleSyncByDay(postsByDay(POSTS, ACCOUNTS, ""), days)).toEqual([
      { day: "2026-03-10", count: 0 },
      { day: "2026-03-11", count: 2 },
      { day: "2026-03-12", count: 0 },
    ]);
  });
});

describe("PER_DAY_CARDS", () => {
  it("is the number of cards a week column shows before it says '+N more'", () => {
    expect(PER_DAY_CARDS).toBe(5);
  });
});
