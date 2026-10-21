import { describe, expect, it, vi } from "vitest";
import type { AnalyticsSummary, ScheduledPost, SocialAccount } from "./api";

// dashboardHelpers pulls in the API client, which needs a database address to start; the logic under test never calls it.
vi.mock("./api", () => ({}));
import {
  brandShares, channelRows, dailySeries, derivePrevious, formatPercent, growthLabel, kpiFigures, networkHealth, postingWindows, proofList,
} from "./analyticsModel";

const summary = (over: Partial<AnalyticsSummary> = {}): AnalyticsSummary => ({
  rangeDays: 30, totalPosts: 999, byStatus: { posted: 40, failed: 3, pending: 500 }, byPlatform: {}, dailyCounts: {}, verifiedLiveRate: 0.9, engagement: {}, ...over,
});
const acct = (id: string, platform: string, brand: string | null, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: id, connected_at: "2026-01-01T00:00:00Z", brand_label: brand, brand_id: brand ? "b-" + brand : null, ...extra,
});
const post = (id: string, over: Partial<ScheduledPost>): ScheduledPost =>
  ({ id, status: "posted", social_account_id: "a1", scheduled_for: "2026-10-20T10:00:00Z", paused_at: null, content: "Sample", post_results: [], ...over }) as unknown as ScheduledPost;

describe("growthLabel", () => {
  it("shows a signed whole-number percentage against the previous period", () => {
    expect(growthLabel(150, 100)).toEqual({ text: "+50%", tone: "up" });
    expect(growthLabel(50, 100)).toEqual({ text: "-50%", tone: "down" });
    expect(growthLabel(100, 100)).toEqual({ text: "0%", tone: "flat" });
    expect(growthLabel(0, 100)).toEqual({ text: "-100%", tone: "down" });
  });
  it("is N/A, never a percentage, when the previous period is 0 or missing", () => {
    for (const prev of [0, null, undefined, Number.NaN]) expect(growthLabel(5, prev)).toEqual({ text: "N/A", tone: "na" });
    expect(growthLabel(null, 5).text).toBe("N/A");
    expect(growthLabel(0, 0).text).toBe("N/A");
  });
  it("caps a huge rise at >+999%", () => {
    expect(growthLabel(1100, 100).text).toBe(">+999%");
    expect(growthLabel(1099, 100).text).toBe("+999%");
    expect(growthLabel(1000000, 1).text).toBe(">+999%");
  });
});

describe("formatPercent", () => {
  it("formats a 0..1 rate and shows a dash for no data, never NaN", () => {
    expect(formatPercent(0.9)).toBe("90%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(Number.NaN)).toBe("—");
  });
});

describe("kpiFigures", () => {
  it("counts Published from byStatus.posted, not from totalPosts which counts every status", () => {
    const k = kpiFigures(summary(), null);
    expect(k.published.value).toBe(40);
    expect(k.failed.value).toBe(3);
    expect(k.verified.display).toBe("90%");
  });
  it("is all zeros and N/A for a brand-new account", () => {
    const k = kpiFigures(null, null);
    expect(k.published.value).toBe(0);
    expect(k.failed.value).toBe(0);
    expect(k.verified.display).toBe("—");
    expect(k.published.growth.text).toBe("N/A");
    expect(k.verified.growth.text).toBe("N/A");
  });
  it("adds growth where the previous period is known", () => {
    const k = kpiFigures(summary(), { published: 20, failed: 0, verifiedLiveRate: 0.45 });
    expect(k.published.growth.text).toBe("+100%");
    expect(k.failed.growth.text).toBe("N/A");
    expect(k.verified.growth.text).toBe("+100%");
  });
});

describe("derivePrevious", () => {
  it("subtracts the current period from a window twice as long", () => {
    const current = summary({ byStatus: { posted: 10, failed: 1 }, byPlatform: { x: { total: 11, posted: 10, failed: 1, verifiedLive: 9 } } });
    const doubled = summary({ rangeDays: 60, byStatus: { posted: 30, failed: 1 }, byPlatform: { x: { total: 31, posted: 30, failed: 1, verifiedLive: 15 } } });
    expect(derivePrevious(current, doubled)).toEqual({ published: 20, failed: 0, verifiedLiveRate: 0.3 });
  });
  it("is null without data, never negative, and has no rate when nothing was posted before", () => {
    expect(derivePrevious(null, summary())).toBeNull();
    expect(derivePrevious(summary(), null)).toBeNull();
    const same = summary({ byStatus: { posted: 5, failed: 2 }, byPlatform: { x: { total: 7, posted: 5, failed: 2, verifiedLive: 5 } } });
    expect(derivePrevious(same, same)).toEqual({ published: 0, failed: 0, verifiedLiveRate: null });
    const smaller = summary({ byStatus: { posted: 1, failed: 0 }, byPlatform: {} });
    expect(derivePrevious(same, smaller)?.published).toBe(0);
  });
});

describe("dailySeries", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  it("returns one point per day of the range, zero-filled, oldest first", () => {
    const s = dailySeries({ "2026-10-21": 4, "2026-10-19": 2 }, 7, now);
    expect(s).toHaveLength(7);
    expect(s[0].date).toBe("2026-10-15");
    expect(s[6]).toEqual({ date: "2026-10-21", count: 4 });
    expect(s.find((p) => p.date === "2026-10-20")?.count).toBe(0);
  });
  it("copes with missing data", () => {
    expect(dailySeries(undefined, 7, now).every((p) => p.count === 0)).toBe(true);
    expect(dailySeries({ "2026-10-21": Number.NaN }, 7, now)[6].count).toBe(0);
  });
});

describe("channelRows", () => {
  it("lists every platform by published count, biggest first, with bar widths relative to the biggest", () => {
    const rows = channelRows({
      mastodon: { total: 30, posted: 21, failed: 0, verifiedLive: 21 },
      tiktok: { total: 12, posted: 12, failed: 0, verifiedLive: 10 },
      bluesky: { total: 5, posted: 0, failed: 5, verifiedLive: 0 },
    });
    expect(rows.map((r) => r.id)).toEqual(["mastodon", "tiktok", "bluesky"]);
    expect(rows[0]).toMatchObject({ label: "Mastodon", count: 21, widthPct: 100 });
    expect(rows[1].widthPct).toBeCloseTo((12 / 21) * 100);
    expect(rows[2].widthPct).toBe(0);
  });
  it("is empty without data", () => {
    expect(channelRows(undefined)).toEqual([]);
    expect(channelRows({})).toEqual([]);
  });
});

describe("brandShares", () => {
  it("computes the total and percentages", () => {
    const s = brandShares([{ name: "Alpha Brand", published: 30 }, { name: "Beta Brand", published: 10 }]);
    expect(s.total).toBe(40);
    expect(s.rows.map((r) => r.pct)).toEqual([75, 25]);
    expect(s.rows[0].name).toBe("Alpha Brand");
  });
  it("gives 0% (not NaN) when nothing was published", () => {
    const s = brandShares([{ name: "Alpha Brand", published: 0 }]);
    expect(s.total).toBe(0);
    expect(s.rows[0].pct).toBe(0);
    expect(brandShares([]).rows).toEqual([]);
  });
});

describe("networkHealth", () => {
  const accounts = [
    acct("a1", "tiktok", "Alpha Brand"), acct("a2", "x", "Alpha Brand"), acct("a3", "facebook", "Alpha Brand", { needs_reconnect_at: "2026-10-01T00:00:00Z" }),
    acct("a4", "x", "Beta Brand"),
  ];
  const posts = [
    post("p1", { status: "pending", social_account_id: "a2", paused_at: "2026-10-20T00:00:00Z" }),
    post("p2", { status: "pending", social_account_id: "a1", paused_at: null }),
    post("p3", { status: "pending", social_account_id: "a1", paused_at: "2026-10-20T00:00:00Z" }),
  ];
  it("splits accounts into active, paused (everything queued is paused) and needing a reconnect", () => {
    const h = networkHealth(accounts, posts, "");
    expect(h).toMatchObject({ active: 2, paused: 1, errors: 1, total: 4 });
    expect(h.microText).toBe("2 Active / 1 Paused / 1 Errors");
  });
  it("follows the brand filter", () => {
    expect(networkHealth(accounts, posts, "Beta Brand")).toMatchObject({ active: 1, paused: 0, errors: 0, total: 1 });
  });
  it("is zero for an empty account", () => {
    expect(networkHealth([], [], "")).toMatchObject({ total: 0, microText: "0 Active / 0 Paused / 0 Errors" });
  });
});

describe("postingWindows", () => {
  const now = new Date(2026, 9, 21, 12, 0); // local time
  const accounts = [acct("a1", "tiktok", "Alpha Brand"), acct("a2", "x", "Beta Brand")];
  // 20 Oct 2026 is a Tuesday
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const posts = [
    post("p1", { scheduled_for: at(20, 14, 5) }),
    post("p2", { scheduled_for: at(20, 14, 50) }),
    post("p3", { scheduled_for: at(13, 14, 10) }),
    post("p4", { scheduled_for: at(19, 9, 0) }),
    post("p5", { scheduled_for: at(20, 14, 0), status: "pending" }),
    post("p6", { scheduled_for: at(20, 14, 0), social_account_id: "a2" }),
    post("p7", { scheduled_for: at(1, 3, 0) }), // outside a 7 day range
  ];
  it("counts only posted posts, in local time, by weekday (Monday first) and hour, and names the busiest window", () => {
    const w = postingWindows(posts, accounts, "Alpha Brand", 30, now);
    expect(w.grid).toHaveLength(7);
    expect(w.grid[0]).toHaveLength(24);
    expect(w.grid[1][14]).toBe(3);
    expect(w.grid[0][9]).toBe(1);
    expect(w.max).toBe(3);
    expect(w.busiest).toEqual({ dayIndex: 1, hour: 14, count: 3, label: "Tuesday 14:00 to 15:00" });
    expect(w.total).toBe(5);
  });
  it("respects the range and the brand", () => {
    expect(postingWindows(posts, accounts, "Alpha Brand", 7, now).total).toBe(3);
    expect(postingWindows(posts, accounts, "", 30, now).total).toBe(6);
  });
  it("has no busiest window and no NaN when nothing was published", () => {
    const w = postingWindows([], accounts, "", 30, now);
    expect(w.busiest).toBeNull();
    expect(w.max).toBe(0);
    expect(w.grid.flat().every((n) => n === 0)).toBe(true);
  });
  it("ignores posts without a usable time", () => {
    expect(postingWindows([post("x", { scheduled_for: null }), post("y", { scheduled_for: "not a date" })], accounts, "", 30, now).total).toBe(0);
  });
});

describe("proofList", () => {
  const accounts = [acct("a1", "tiktok", "Alpha Brand"), acct("a2", "x", "Beta Brand")];
  const verified = (url: string | null) => [{ verified_live: true, platform_post_url: url, error_message: null }];
  const posts = [
    post("old", { scheduled_for: "2026-10-01T10:00:00Z", post_results: verified("https://example.com/p/old") }),
    post("new", { scheduled_for: "2026-10-20T10:00:00Z", post_results: verified("https://example.com/p/new") }),
    post("beta", { scheduled_for: "2026-10-19T10:00:00Z", social_account_id: "a2", post_results: verified("https://example.com/p/beta") }),
    post("unverified", { post_results: [{ verified_live: false, platform_post_url: "https://example.com/p/u", error_message: null }] }),
    post("nolink", { post_results: verified(null) }),
    post("unsafe", { post_results: verified("javascript:alert(1)") }),
    post("pending", { status: "pending", post_results: verified("https://example.com/p/pending") }),
  ];
  it("lists only posted, verified posts that have a safe web link, newest first", () => {
    const list = proofList(posts, accounts, "", 20);
    expect(list.map((p) => p.id)).toEqual(["new", "beta", "old"]);
    expect(list[0]).toMatchObject({ platform: "tiktok", url: "https://example.com/p/new" });
  });
  it("follows the brand filter and the limit", () => {
    expect(proofList(posts, accounts, "Beta Brand", 20).map((p) => p.id)).toEqual(["beta"]);
    expect(proofList(posts, accounts, "", 2)).toHaveLength(2);
  });
  it("copes with a post that has no results array", () => {
    expect(proofList([post("z", { post_results: undefined as unknown as [] })], accounts, "", 20)).toEqual([]);
  });
});
