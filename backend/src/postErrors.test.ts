import { describe, it, expect } from "vitest";
import { classifyPostError, type PostErrorKind } from "./postErrors.js";

// The first block is copied from failures LazyRelay really recorded
// (post_results, checked 2026-09-30). The second block is the codes the
// platforms document publicly.
const REAL: Array<[string, string, PostErrorKind]> = [
  ["pinterest", "Sorry! We blocked this link because it may lead to spam.", "fatal"],
  ["tiktok", "Client key or secret is incorrect.", "ours"],
  ["tiktok", "Refresh token is invalid or expired.", "reconnect"],
  ["mastodon", "Cannot attach files that have not finished processing. Try again in a moment!", "retry"],
  ["threads", "The requested resource does not exist", "retry"],
  ["facebook", "Confirm your identity before you can publish as this Page. Open the Facebook app on your phone and follow the instructions.", "fatal"],
  ["bluesky", "Token has expired", "reconnect"],
  ["facebook", "Facebook video is not ready yet (status: processing)", "retry"],
  ["facebook", "Facebook video is not ready yet (status: uploading)", "retry"],
  ["tiktok", "Please review our integration guidelines at https://developers.tiktok.com/doc/content-sharing-guidelines/", "fatal"],
  ["tumblr", "Unable to authorize", "reconnect"],
  ["pinterest", "Pinterest video processing did not finish in time", "retry"],
  ["facebook", "Unsupported get request. Object with ID '1234567890' does not exist, cannot be loaded due to missing permissions, or does not support this operation.", "retry"],
];

const DOCUMENTED: Array<[string, string, PostErrorKind]> = [
  ["tiktok", "spam_risk_too_many_posts", "fatal"],
  ["tiktok", "spam_risk_user_banned_from_posting", "fatal"],
  ["tiktok", "privacy_level_option_mismatch", "fatal"],
  ["tiktok", "access_token_invalid", "reconnect"],
  ["tiktok", "scope_not_authorized", "reconnect"],
  ["tiktok", "rate_limit_exceeded", "retry"],
  ["tiktok", "unaudited_client_can_only_post_to_private_accounts", "ours"],
  ["tiktok", "url_ownership_unverified", "ours"],
  ["tiktok", "reached_active_user_cap", "ours"],
  ["facebook", '{"error":{"message":"Error validating access token: Session has been invalidated","type":"OAuthException","code":190}}', "reconnect"],
  ["instagram", '{"error":{"message":"Application request limit reached","code":4}}', "retry"],
  ["instagram", '{"error":{"message":"(#17) User request limit reached","code":17}}', "retry"],
  ["facebook", '{"error":{"message":"(#368) Temporarily blocked for policies violations","code":368}}', "fatal"],
  ["facebook", '{"error":{"message":"(#200) Requires pages_manage_posts permission","code":200}}', "reconnect"],
  ["facebook", '{"error":{"message":"An unknown error has occurred.","code":1}}', "retry"],
];

describe("classifyPostError", () => {
  it.each(REAL)("real failure: %s | %s -> %s", (platform, raw, kind) => {
    expect(classifyPostError(platform, raw).kind).toBe(kind);
  });

  it.each(DOCUMENTED)("documented code: %s | %s -> %s", (platform, raw, kind) => {
    expect(classifyPostError(platform, raw).kind).toBe(kind);
  });

  it("never blames or flags the customer for our own bad app credentials, even when the text also mentions a token", () => {
    const c = classifyPostError("tiktok", "invalid_client: token request failed, client key or secret is incorrect");
    expect(c.kind).toBe("ours");
    expect(c.message).toMatch(/We have been alerted/);
  });

  it("gives the customer a plain-language reason with the platform name and no raw codes", () => {
    const c = classifyPostError("pinterest", "Sorry! We blocked this link because it may lead to spam.");
    expect(c.message).toMatch(/^Pinterest blocked the link/);
    expect(c.message).not.toMatch(/Sorry!/);
  });

  it("keeps today's behavior for an error it doesn't recognise: retry, raw text", () => {
    const c = classifyPostError("linkedin", "Something nobody has seen before");
    expect(c).toEqual({ kind: "retry", message: "Something nobody has seen before" });
  });

  it("platform-specific rules only apply to their own platform", () => {
    // The Pinterest spam-link wording on another platform is not the Pinterest rule.
    expect(classifyPostError("mastodon", "Sorry! We blocked this link because it may lead to spam.").kind).toBe("retry");
  });

  it("a code number inside an unrelated id does not trigger a rate-limit rule", () => {
    expect(classifyPostError("facebook", "Post 1234290567 failed for an unknown reason").kind).toBe("retry");
  });
});
