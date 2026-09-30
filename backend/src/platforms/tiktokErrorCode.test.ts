import { describe, it, expect } from "vitest";
import { describeTikTokError } from "./tiktok.js";
import { classifyPostError } from "../postErrors.js";

describe("describeTikTokError", () => {
  it("keeps TikTok's error code and log id next to its message", () => {
    const msg = describeTikTokError(
      { code: "spam_risk_too_many_posts", message: "Please review our integration guidelines at https://developers.tiktok.com/doc/content-sharing-guidelines/", log_id: "abc123" },
      "fallback",
    );
    expect(msg).toBe("Please review our integration guidelines at https://developers.tiktok.com/doc/content-sharing-guidelines/ (TikTok code: spam_risk_too_many_posts, log: abc123)");
  });

  it("uses the fallback when TikTok sent nothing, and skips a code of ok", () => {
    expect(describeTikTokError(undefined, "TikTok post init failed (HTTP 500)")).toBe("TikTok post init failed (HTTP 500)");
    expect(describeTikTokError({ code: "ok", message: "" }, "fallback")).toBe("fallback");
    expect(describeTikTokError({ code: "ok", message: "Something", log_id: "L1" }, "fallback")).toBe("Something (TikTok log: L1)");
  });

  it("lets the classifier recognise the code that the generic sentence used to hide", () => {
    const generic = "Please review our integration guidelines at https://developers.tiktok.com/doc/content-sharing-guidelines/";
    const withCode = describeTikTokError({ code: "spam_risk_too_many_posts", message: generic }, "x");
    const before = classifyPostError("tiktok", generic);
    const after = classifyPostError("tiktok", withCode);
    expect(after.message).not.toBe(before.message); // the specific reason now wins over the generic one
  });
});
