import { describe, it, expect } from "vitest";
import { parseCreatorInfo, TIKTOK_CANT_POST_MESSAGES } from "./tiktokCreatorInfo.js";

// The normal reply, taken from TikTok's own sample response on the
// creator_info/query reference page.
const okReply = {
  data: {
    creator_avatar_url: "https://example.com/avatar.jpg",
    creator_username: "tiktok",
    creator_nickname: "TikTok Official",
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
    comment_disabled: false,
    duet_disabled: false,
    stitch_disabled: true,
    max_video_post_duration_sec: 300,
  },
  error: { code: "ok", message: "", log_id: "202210112248442CB9319E1FB30C1073F3" },
};

describe("parseCreatorInfo", () => {
  it("reads a normal reply", () => {
    expect(parseCreatorInfo(okReply)).toEqual({
      nickname: "TikTok Official",
      maxVideoDurationSec: 300,
      canPost: true,
      cantPostReason: null,
      privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
    });
  });

  it.each(["spam_risk_too_many_posts", "spam_risk_user_banned_from_posting", "reached_active_user_cap"])(
    "blocks posting with a try-later message for %s",
    (code) => {
      const result = parseCreatorInfo({ data: {}, error: { code, message: "" } });
      expect(result.canPost).toBe(false);
      expect(result.cantPostReason).toBe(TIKTOK_CANT_POST_MESSAGES[code]);
      expect(result.cantPostReason).toMatch(/try again later/);
    },
  );

  it("does not block on error codes that aren't about posting limits", () => {
    const result = parseCreatorInfo({ error: { code: "rate_limit_exceeded", message: "" } });
    expect(result.canPost).toBe(true);
    expect(result.cantPostReason).toBeNull();
  });

  it("treats a missing or invalid max duration as unknown", () => {
    expect(parseCreatorInfo({ data: { creator_nickname: "x" } }).maxVideoDurationSec).toBeNull();
    expect(parseCreatorInfo({ data: { max_video_post_duration_sec: 0 } }).maxVideoDurationSec).toBeNull();
    expect(parseCreatorInfo({ data: { max_video_post_duration_sec: "300" } }).maxVideoDurationSec).toBeNull();
  });

  it("handles empty or non-object input without throwing", () => {
    for (const input of [null, undefined, "not json", 42, {}]) {
      expect(parseCreatorInfo(input)).toEqual({
        nickname: null,
        maxVideoDurationSec: null,
        canPost: true,
        cantPostReason: null,
        privacyLevelOptions: [],
      });
    }
  });
});
