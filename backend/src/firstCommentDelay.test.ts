import { describe, it, expect } from "vitest";
import {
  normalizeFirstCommentDelay,
  delayForPlatform,
  firstCommentDueAt,
  decideFirstComment,
  FIRST_COMMENT_DELAY_PLATFORMS,
  FIRST_COMMENT_STALE_AFTER_MS,
} from "./firstCommentDelay.js";

describe("normalizeFirstCommentDelay", () => {
  it("is optional: nothing, null, empty and 0 all mean right away", () => {
    for (const v of [undefined, null, "", 0, "0"]) {
      expect(normalizeFirstCommentDelay(v, "hi", "instagram")).toEqual({ ok: true, value: null });
    }
    // 0 is harmless even with no comment or on a platform with no comments
    expect(normalizeFirstCommentDelay(0, null, "tiktok")).toEqual({ ok: true, value: null });
  });

  it("accepts whole minutes from 1 to 1440, as a number or a numeric string", () => {
    expect(normalizeFirstCommentDelay(5, "hi", "facebook")).toEqual({ ok: true, value: 5 });
    expect(normalizeFirstCommentDelay("30", "hi", "instagram")).toEqual({ ok: true, value: 30 });
    expect(normalizeFirstCommentDelay(1440, "hi", "instagram")).toEqual({ ok: true, value: 1440 });
  });

  it("rejects negatives, fractions, text and more than 24 hours, in plain English", () => {
    const bad = (v: unknown) => normalizeFirstCommentDelay(v, "hi", "instagram");
    expect(bad(-1)).toEqual({ ok: false, error: "firstCommentDelayMinutes can't be negative" });
    expect(bad(2.5)).toMatchObject({ ok: false, error: "firstCommentDelayMinutes must be a whole number of minutes" });
    expect(bad("soon")).toMatchObject({ ok: false });
    expect(bad(NaN)).toMatchObject({ ok: false });
    expect(bad(true)).toMatchObject({ ok: false });
    expect(bad(1441)).toMatchObject({ ok: false, error: expect.stringContaining("at most 1440 minutes (24 hours)") });
  });

  it("needs a first comment to delay", () => {
    for (const comment of [undefined, null, "", "   "]) {
      expect(normalizeFirstCommentDelay(15, comment, "instagram")).toEqual({
        ok: false,
        error: "A delay before the first comment needs a first comment to delay",
      });
    }
  });

  it("is refused on platforms that do not post first comments, but a draft (no platform) is only shape-checked", () => {
    expect(normalizeFirstCommentDelay(15, "hi", "tiktok")).toEqual({
      ok: false,
      error: "Delaying the first comment is only available for Facebook and Instagram posts",
    });
    expect(normalizeFirstCommentDelay(15, "hi", null)).toEqual({ ok: true, value: 15 });
  });

  it("is on for exactly Facebook and Instagram", () => {
    expect(FIRST_COMMENT_DELAY_PLATFORMS).toEqual(["facebook", "instagram"]);
  });
});

describe("delayForPlatform (recurring schedules)", () => {
  it("keeps the delay on a supporting platform and drops it elsewhere", () => {
    const slot = { first_comment: "hi", first_comment_delay_minutes: 30 };
    expect(delayForPlatform(slot, "instagram")).toBe(30);
    expect(delayForPlatform(slot, "bluesky")).toBeNull();
    expect(delayForPlatform({ first_comment: null, first_comment_delay_minutes: 30 }, "instagram")).toBeNull();
    expect(delayForPlatform({}, "instagram")).toBeNull();
  });
});

describe("due time", () => {
  const T0 = Date.parse("2026-10-01T10:00:00Z");
  it("is now plus the delay, and nothing for right away", () => {
    expect(firstCommentDueAt(30, T0)).toBe("2026-10-01T10:30:00.000Z");
    expect(firstCommentDueAt(0, T0)).toBeNull();
    expect(firstCommentDueAt(null, T0)).toBeNull();
    expect(firstCommentDueAt(undefined, T0)).toBeNull();
  });

  it("waits before it is due, posts from the due time, and goes stale after 24 hours", () => {
    const due = "2026-10-01T10:30:00.000Z";
    const dueMs = Date.parse(due);
    expect(decideFirstComment(due, dueMs - 1)).toBe("wait");
    expect(decideFirstComment(due, dueMs)).toBe("post");
    expect(decideFirstComment(due, dueMs + FIRST_COMMENT_STALE_AFTER_MS)).toBe("post");
    expect(decideFirstComment(due, dueMs + FIRST_COMMENT_STALE_AFTER_MS + 1)).toBe("stale");
  });
});
