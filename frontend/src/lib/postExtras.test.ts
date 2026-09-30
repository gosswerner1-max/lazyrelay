import { describe, it, expect } from "vitest";
import { describeExtras } from "./postExtras";

const base = { tags: [], media_urls: [], self_reply_text: null, self_reply_at_likes: null, self_reply_done_at: null, self_reply_error: null };

describe("describeExtras", () => {
  it("says nothing for a plain post", () => {
    expect(describeExtras(base)).toEqual([]);
    expect(describeExtras({ ...base, tags: null, media_urls: null })).toEqual([]);
  });
  it("shows tags and the total image count", () => {
    expect(describeExtras({ ...base, tags: ["launch", "sale"], media_urls: ["a", "b"] })).toEqual(["Tags: launch, sale", "3 images"]);
  });
  it("shows the self-reply as waiting, sent, or failed with the reason", () => {
    const set = { ...base, self_reply_text: "Thanks!", self_reply_at_likes: 50 };
    expect(describeExtras(set)).toEqual(["Self-reply at 50 likes"]);
    expect(describeExtras({ ...set, self_reply_done_at: "2026-09-30T10:00:00Z" })).toEqual(["Self-reply sent"]);
    expect(describeExtras({ ...set, self_reply_done_at: "2026-09-30T10:00:00Z", self_reply_error: "Comments are turned off" })).toEqual([
      "Self-reply could not be sent: Comments are turned off",
    ]);
  });
});
