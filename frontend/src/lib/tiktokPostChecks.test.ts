import { describe, it, expect } from "vitest";
import {
  formatDuration,
  isVideoTooLongForTiktok,
  tiktokVideoTooLongMessage,
  TIKTOK_PRIVACY_LEVEL_LABELS,
} from "./tiktokPostChecks";

describe("isVideoTooLongForTiktok", () => {
  it("is true when the video is longer than TikTok's limit", () => {
    expect(isVideoTooLongForTiktok(301, 300)).toBe(true);
    expect(isVideoTooLongForTiktok(750, 600)).toBe(true);
  });

  it("is false when the video is within the limit", () => {
    expect(isVideoTooLongForTiktok(45, 300)).toBe(false);
  });

  it("is false exactly at the limit, including a fraction of a second over", () => {
    expect(isVideoTooLongForTiktok(300, 300)).toBe(false);
    expect(isVideoTooLongForTiktok(300.9, 300)).toBe(false);
  });

  it("never blocks when the length or the limit is unknown or invalid", () => {
    expect(isVideoTooLongForTiktok(null, 300)).toBe(false);
    expect(isVideoTooLongForTiktok(900, null)).toBe(false);
    expect(isVideoTooLongForTiktok(Number.NaN, 300)).toBe(false);
    expect(isVideoTooLongForTiktok(Number.POSITIVE_INFINITY, 300)).toBe(false);
    expect(isVideoTooLongForTiktok(900, 0)).toBe(false);
  });
});

describe("formatDuration", () => {
  it("formats whole seconds as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(59.9)).toBe("0:59");
    expect(formatDuration(605)).toBe("10:05");
  });
});

describe("tiktokVideoTooLongMessage", () => {
  it("names both lengths", () => {
    expect(tiktokVideoTooLongMessage(750, 600)).toBe(
      "This video is 12:30 long, but TikTok lets this account post videos up to 10:00. Choose a shorter video.",
    );
  });
});

// Confirmed live 2026-09-15 against TikTok's own creator_info API reference:
// public accounts return PUBLIC_TO_EVERYONE/MUTUAL_FOLLOW_FRIENDS/SELF_ONLY,
// private accounts return FOLLOWER_OF_CREATOR/MUTUAL_FOLLOW_FRIENDS/SELF_ONLY
// instead — a fixed dropdown can never show the right set for both.
describe("TIKTOK_PRIVACY_LEVEL_LABELS", () => {
  it("covers every value TikTok's creator_info API can return", () => {
    for (const value of ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY", "FOLLOWER_OF_CREATOR"]) {
      expect(TIKTOK_PRIVACY_LEVEL_LABELS[value]).toBeTypeOf("string");
    }
  });
});
