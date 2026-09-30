import { describe, it, expect } from "vitest";
import { selfReplyFields, supportsSelfReply } from "./selfReply";

describe("selfReplyFields", () => {
  it("sends both fields on a Facebook or Instagram post", () => {
    expect(selfReplyFields("facebook", " Thanks! ", "50")).toEqual({ selfReplyText: "Thanks!", selfReplyAtLikes: 50 });
    expect(supportsSelfReply("instagram")).toBe(true);
  });
  it("sends nothing on other platforms, or when half filled in or not a whole number", () => {
    expect(selfReplyFields("tiktok", "Thanks!", "50")).toEqual({});
    expect(selfReplyFields("facebook", "", "50")).toEqual({});
    expect(selfReplyFields("facebook", "Thanks!", "")).toEqual({});
    expect(selfReplyFields("facebook", "Thanks!", "2.5")).toEqual({});
  });
});
