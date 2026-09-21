import { describe, it, expect } from "vitest";
import {
  ROLLING_WINDOW_MS,
  COUNTED_POST_STATUSES,
  DEFAULT_PINTEREST_DAILY_POST_LIMIT,
  PLATFORM_ROLLING_24H_POST_LIMIT,
  getRolling24hPostLimit,
  nextAllowedTime,
  parsePostLimitEnv,
  platformLimitMessage,
  wouldExceedRolling24hLimit,
} from "./platformPostLimits.js";

// En-dash and em-dash, built from code points so no literal dash sits in this file.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const HOUR = 60 * 60 * 1000;
const BASE = Date.UTC(2026, 8, 21, 0, 0, 0); // 2026-09-21T00:00:00Z
const at = (hours: number) => new Date(BASE + hours * HOUR);
/** n posts, one every `stepHours`, starting at hour `startHour`. */
const run = (n: number, startHour: number, stepHours: number) =>
  Array.from({ length: n }, (_, i) => at(startHour + i * stepHours));

describe("wouldExceedRolling24hLimit", () => {
  it("allows a post when there is no history", () => {
    expect(wouldExceedRolling24hLimit([], at(5), 10)).toBe(false);
  });

  it("allows the post that lands exactly on the limit (9 existing + 1 = 10)", () => {
    expect(wouldExceedRolling24hLimit(run(9, 0, 1), at(10), 10)).toBe(false);
  });

  it("rejects the post that goes one over (10 existing + 1 = 11)", () => {
    expect(wouldExceedRolling24hLimit(run(10, 0, 1), at(10), 10)).toBe(true);
  });

  it("uses half-open windows: a post exactly 24h after another is NOT in the same window", () => {
    // 10 posts at hours 0..9. A new post at hour 24 is exactly 24h after the
    // one at hour 0, so that one has aged out: the window [1h, 25h) holds
    // only 9 existing + the new one = 10, which is allowed.
    expect(wouldExceedRolling24hLimit(run(10, 0, 1), at(24), 10)).toBe(false);
  });

  it("rejects a post 1ms short of the 24h boundary", () => {
    const justInside = new Date(at(24).getTime() - 1);
    expect(wouldExceedRolling24hLimit(run(10, 0, 1), justInside, 10)).toBe(true);
  });

  it("treats a limit of 1 with a post exactly 24h earlier as fine, and 23h59m as not", () => {
    expect(wouldExceedRolling24hLimit([at(0)], at(24), 1)).toBe(false);
    expect(wouldExceedRolling24hLimit([at(0)], new Date(at(24).getTime() - 60_000), 1)).toBe(true);
  });

  it("does not depend on input order", () => {
    const sorted = run(10, 0, 1);
    const shuffled = [sorted[7], sorted[2], sorted[9], sorted[0], sorted[5], sorted[3], sorted[8], sorted[1], sorted[6], sorted[4]];
    expect(wouldExceedRolling24hLimit(shuffled, at(10), 10)).toBe(true);
    expect(wouldExceedRolling24hLimit(shuffled.slice(1), at(10), 10)).toBe(false);
  });

  it("does not mutate the array it is given", () => {
    const input = [at(3), at(1), at(2)];
    const copy = [...input];
    wouldExceedRolling24hLimit(input, at(4), 10);
    expect(input).toEqual(copy);
  });

  it("counts posts on both sides of the new time, not only earlier ones", () => {
    // 5 before and 5 after the new time, all within one 24h window with it.
    const existing = [...run(5, 0, 1), ...run(5, 6, 1)]; // hours 0-4 and 6-10
    expect(wouldExceedRolling24hLimit(existing, at(5), 10)).toBe(true);
    // With one of the later ones removed, 9 + 1 = 10 fits.
    expect(wouldExceedRolling24hLimit(existing.slice(0, -1), at(5), 10)).toBe(false);
  });

  it("counts a single future-side burst even when nothing precedes the new time", () => {
    expect(wouldExceedRolling24hLimit(run(10, 1, 1), at(0), 10)).toBe(true);
  });

  it("ignores a full day that sits more than 24h away", () => {
    // Legacy: 12 posts on day 1 (already over any cap). A new post on day 3
    // is not made worse by them and must not be blocked.
    expect(wouldExceedRolling24hLimit(run(12, 0, 1), at(48), 10)).toBe(false);
  });

  it("finds the tight window even when a wide spread hides it from any single day boundary", () => {
    // 6 posts in hours 12-17 and 4 in hours 30-33; a new post at hour 30.5
    // sees window [12h..36h) hold all 10 existing + new = 11.
    const existing = [...run(6, 12, 1), ...run(4, 30, 1)];
    expect(wouldExceedRolling24hLimit(existing, at(30.5), 10)).toBe(true);
    // Pushed to hour 36 the hour-12 post is 24h old and the window frees up.
    expect(wouldExceedRolling24hLimit(existing, at(36), 10)).toBe(false);
  });
});

describe("nextAllowedTime", () => {
  it("returns the desired time when it already fits", () => {
    const desired = at(5);
    const result = nextAllowedTime(run(3, 0, 1), desired, 10);
    expect(result.getTime()).toBe(desired.getTime());
    expect(result).not.toBe(desired); // a copy, never the caller's own object
  });

  it("returns the desired time on empty history", () => {
    expect(nextAllowedTime([], at(2), 10).getTime()).toBe(at(2).getTime());
  });

  it("skips past a full window to the moment the oldest post ages out", () => {
    // Full day: 10 posts at hours 0..9. Wanting hour 10 means waiting until
    // the hour-0 post is 24h old, i.e. hour 24.
    const result = nextAllowedTime(run(10, 0, 1), at(10), 10);
    expect(result.getTime()).toBe(at(24).getTime());
  });

  it("the time it returns is itself allowed, and 1ms earlier is not", () => {
    const existing = run(10, 0, 1);
    const result = nextAllowedTime(existing, at(10), 10);
    expect(wouldExceedRolling24hLimit(existing, result, 10)).toBe(false);
    expect(wouldExceedRolling24hLimit(existing, new Date(result.getTime() - 1), 10)).toBe(true);
  });

  it("skips past several full days in a row", () => {
    // 10 a day for 3 days straight (hours 0-9, 24-33, 48-57). Wanting hour 5
    // of day 1: day 1 is full, then day 2's window (starting at its first
    // post) is full, then day 3's. The first slot with room is hour 72, when
    // the hour-48 post ages out of day 3's window.
    const existing = [...run(10, 0, 1), ...run(10, 24, 1), ...run(10, 48, 1)];
    const result = nextAllowedTime(existing, at(5), 10);
    expect(result.getTime()).toBe(at(72).getTime());
    expect(wouldExceedRolling24hLimit(existing, result, 10)).toBe(false);
    // and nothing earlier than it (from the desired time on) was allowed
    for (let h = 5; h < (result.getTime() - BASE) / HOUR; h += 0.25) {
      expect(wouldExceedRolling24hLimit(existing, at(h), 10)).toBe(true);
    }
  });

  it("uses an unsorted history correctly", () => {
    const existing = run(10, 0, 1).reverse();
    expect(nextAllowedTime(existing, at(3), 10).getTime()).toBe(at(24).getTime());
  });

  it("with posts on both sides, waits for enough of them to age out", () => {
    // 5 before and 5 after hour 5 (hours 0-4, 6-10); limit 10, so hour 5 is
    // blocked. The first time it fits is when the hour-0 post ages out (24).
    const existing = [...run(5, 0, 1), ...run(5, 6, 1)];
    expect(nextAllowedTime(existing, at(5), 10).getTime()).toBe(at(24).getTime());
  });

  it("works with a limit of 1", () => {
    expect(nextAllowedTime([at(0)], at(3), 1).getTime()).toBe(at(24).getTime());
  });
});

describe("parsePostLimitEnv", () => {
  it("falls back to the default when unset", () => {
    expect(parsePostLimitEnv(undefined, 10)).toBe(10);
  });

  it("accepts a valid positive integer, with surrounding whitespace", () => {
    expect(parsePostLimitEnv("25", 10)).toBe(25);
    expect(parsePostLimitEnv(" 7 ", 10)).toBe(7);
  });

  it("falls back to 10 for anything invalid, zero, negative or fractional", () => {
    for (const bad of ["", "   ", "abc", "0", "-5", "10.5", "1e3", "0x10", "10 posts", "NaN", "Infinity", "99999999999999999999999"]) {
      expect(parsePostLimitEnv(bad, 10), `input ${JSON.stringify(bad)}`).toBe(10);
    }
  });
});

describe("platform limit table", () => {
  it("has Pinterest at the documented default (assuming PINTEREST_DAILY_POST_LIMIT is not set in the test env)", () => {
    expect(DEFAULT_PINTEREST_DAILY_POST_LIMIT).toBe(10);
    if (process.env.PINTEREST_DAILY_POST_LIMIT === undefined) {
      expect(PLATFORM_ROLLING_24H_POST_LIMIT.pinterest).toBe(10);
    }
    expect(getRolling24hPostLimit("pinterest")).toBe(PLATFORM_ROLLING_24H_POST_LIMIT.pinterest);
  });

  it("has no cap for any other platform", () => {
    for (const platform of ["tiktok", "youtube", "mastodon", "bluesky", "telegram", "linkedin", "threads", "facebook", "instagram", "discord", "tumblr", "x"]) {
      expect(getRolling24hPostLimit(platform)).toBeNull();
    }
  });

  it("counts exactly the four live statuses (never draft or failed)", () => {
    expect([...COUNTED_POST_STATUSES]).toEqual(["pending", "posting", "posted", "needs_approval"]);
  });

  it("defines the window as 24 hours", () => {
    expect(ROLLING_WINDOW_MS).toBe(24 * HOUR);
  });
});

describe("platformLimitMessage", () => {
  it("names the limit and the next free time in plain language, in UTC", () => {
    const msg = platformLimitMessage("pinterest", 10, new Date(Date.UTC(2026, 8, 22, 14, 5)));
    expect(msg).toBe(
      "Pinterest allows up to 10 pins a day per account, and that day is full. The next free time is September 22, 2026 at 14:05 UTC.",
    );
  });

  it("uses no em-dash or en-dash", () => {
    expect(platformLimitMessage("pinterest", 10, new Date())).not.toMatch(DASHES);
  });
});
