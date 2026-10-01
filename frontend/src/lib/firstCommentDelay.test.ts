import { describe, it, expect } from "vitest";
import {
  FIRST_COMMENT_DELAY_OPTIONS,
  showFirstCommentDelay,
  firstCommentDelayField,
  firstCommentDelayForDraft,
  describeFirstComment,
  formatDueTime,
  delayLabel,
} from "./firstCommentDelay";

describe("options", () => {
  it("are right away, 5, 15, 30 minutes, 1, 2, 6 and 24 hours, and never past the 24 hour limit", () => {
    expect(FIRST_COMMENT_DELAY_OPTIONS.map((o) => o.value)).toEqual([0, 5, 15, 30, 60, 120, 360, 1440]);
    expect(FIRST_COMMENT_DELAY_OPTIONS[0].label).toBe("Right away");
  });
});

describe("showFirstCommentDelay", () => {
  it("needs a typed comment and a chosen Facebook or Instagram account", () => {
    expect(showFirstCommentDelay("Hi", ["instagram"])).toBe(true);
    expect(showFirstCommentDelay("Hi", ["tiktok", "facebook"])).toBe(true);
    expect(showFirstCommentDelay("Hi", ["tiktok", "bluesky"])).toBe(false);
    expect(showFirstCommentDelay("Hi", [])).toBe(false);
    expect(showFirstCommentDelay("", ["instagram"])).toBe(false);
    expect(showFirstCommentDelay("   ", ["instagram"])).toBe(false);
    expect(showFirstCommentDelay(null, ["instagram"])).toBe(false);
  });
});

describe("request fields", () => {
  it("sends the delay only for a supporting platform with a comment and a delay above 0", () => {
    expect(firstCommentDelayField("instagram", "Hi", 30)).toEqual({ firstCommentDelayMinutes: 30 });
    expect(firstCommentDelayField("facebook", "Hi", "60")).toEqual({ firstCommentDelayMinutes: 60 });
    expect(firstCommentDelayField("instagram", "Hi", 0)).toEqual({});
    expect(firstCommentDelayField("instagram", "", 30)).toEqual({});
    expect(firstCommentDelayField("instagram", null, 30)).toEqual({});
    expect(firstCommentDelayField("tiktok", "Hi", 30)).toEqual({});
    expect(firstCommentDelayField(undefined, "Hi", 30)).toEqual({});
    expect(firstCommentDelayField("instagram", "Hi", 2.5)).toEqual({});
  });
  it("a draft keeps the delay with a comment and clears it otherwise", () => {
    expect(firstCommentDelayForDraft("Hi", 15)).toBe(15);
    expect(firstCommentDelayForDraft("Hi", 0)).toBeNull();
    expect(firstCommentDelayForDraft("", 15)).toBeNull();
    expect(firstCommentDelayForDraft(null, 15)).toBeNull();
  });
});

describe("describeFirstComment", () => {
  const now = new Date(2026, 9, 1, 10, 0);
  const at = (h: number, m: number, day = 1) => new Date(2026, 9, day, h, m).toISOString();
  it("says nothing without a comment", () => {
    expect(describeFirstComment({ first_comment: null }, now)).toEqual([]);
  });
  it("shows the plan while the post is waiting", () => {
    expect(describeFirstComment({ first_comment: "Hi", first_comment_delay_minutes: 30, status: "pending" }, now)).toEqual(["First comment 30 minutes after it goes live"]);
    expect(describeFirstComment({ first_comment: "Hi", first_comment_delay_minutes: 120, status: "pending" }, now)).toEqual(["First comment 2 hours after it goes live"]);
    expect(describeFirstComment({ first_comment: "Hi", first_comment_delay_minutes: null, status: "pending" }, now)).toEqual([]);
  });
  it("shows Comment due at HH:MM while it is pending", () => {
    const p = { first_comment: "Hi", first_comment_delay_minutes: 30, status: "posted", post_results: [{ first_comment_due_at: at(14, 5) }] };
    expect(describeFirstComment(p, now)).toEqual(["Comment due at 14:05"]);
    expect(describeFirstComment({ ...p, post_results: [{ first_comment_due_at: at(9, 7, 2) }] }, now)).toEqual(["Comment due at 09:07 on 2 Oct"]);
  });
  it("shows the result afterwards, with the reason when it failed", () => {
    const base = { first_comment: "Hi", first_comment_delay_minutes: 30, status: "posted" };
    expect(describeFirstComment({ ...base, post_results: [{ first_comment_due_at: at(14, 5), first_comment_posted: true }] }, now)).toEqual(["First comment posted"]);
    expect(describeFirstComment({ ...base, post_results: [{ first_comment_due_at: at(14, 5), first_comment_posted: false, first_comment_error: "Comments are turned off" }] }, now)).toEqual([
      "First comment could not be posted: Comments are turned off",
    ]);
  });
  it("an immediate comment shows only its result", () => {
    expect(describeFirstComment({ first_comment: "Hi", status: "posted", post_results: [{ first_comment_posted: true }] }, now)).toEqual(["First comment posted"]);
    expect(describeFirstComment({ first_comment: "Hi", status: "posted", post_results: [{}] }, now)).toEqual([]);
  });
});

describe("formatting", () => {
  it("pads the time and names the delay", () => {
    expect(formatDueTime(new Date(2026, 9, 1, 7, 5).toISOString(), new Date(2026, 9, 1, 6, 0))).toBe("07:05");
    expect(delayLabel(5)).toBe("5 minutes");
    expect(delayLabel(60)).toBe("1 hour");
    expect(delayLabel(1440)).toBe("24 hours");
  });
});
