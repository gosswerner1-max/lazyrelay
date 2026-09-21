import { describe, it, expect } from "vitest";
import { humanizeErrorMessage, PINTEREST_BLOCKED_LINK_MESSAGE, PINTEREST_DAILY_LIMIT_MESSAGE } from "./errorMessages";

// En-dash and em-dash, built from code points so no literal dash sits in this file.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

describe("humanizeErrorMessage: Pinterest rejections", () => {
  it("explains a blocked link in plain language and keeps Pinterest's own text as the technical detail", () => {
    const raw = "Sorry! We blocked this link because it may lead to spam.";
    const { friendly, technical } = humanizeErrorMessage(raw, "pinterest");
    expect(friendly).toBe(PINTEREST_BLOCKED_LINK_MESSAGE);
    expect(friendly).toContain("Pinterest's Help Center (Appeals, then Pinterest blocked my site)");
    expect(technical).toBe(raw);
  });

  it("recognises the blocked-link text when Pinterest wraps it in a longer API error", () => {
    const raw = 'Pinterest API error 400: {"code":2,"message":"Sorry! We blocked this link because it may lead to spam."}';
    const { friendly, technical } = humanizeErrorMessage(raw, "pinterest");
    expect(friendly).toBe(PINTEREST_BLOCKED_LINK_MESSAGE);
    expect(technical).toBe(raw);
  });

  it("explains the daily limit and keeps the raw text", () => {
    const raw = "You have reached the maximum number of 10 posts for the last 24 hours for this account";
    const { friendly, technical } = humanizeErrorMessage(raw, "pinterest");
    expect(friendly).toBe(PINTEREST_DAILY_LIMIT_MESSAGE);
    expect(technical).toBe(raw);
  });

  it("matches regardless of case, and does not need the platform argument", () => {
    expect(humanizeErrorMessage("MAXIMUM NUMBER OF 10 POSTS FOR THE LAST 24 HOURS", undefined).friendly).toBe(
      PINTEREST_DAILY_LIMIT_MESSAGE,
    );
    expect(humanizeErrorMessage("we BLOCKED this link because it may lead to spam", undefined).friendly).toBe(
      PINTEREST_BLOCKED_LINK_MESSAGE,
    );
  });

  it("does not claim the daily limit for unrelated messages that mention 24 hours or posts", () => {
    expect(humanizeErrorMessage("Token expires in 24 hours", "pinterest").friendly).not.toBe(PINTEREST_DAILY_LIMIT_MESSAGE);
    expect(humanizeErrorMessage("maximum number of retries reached", "pinterest").friendly).not.toBe(PINTEREST_DAILY_LIMIT_MESSAGE);
  });

  it("uses no em-dash or en-dash in the new customer-facing copy", () => {
    expect(PINTEREST_BLOCKED_LINK_MESSAGE).not.toMatch(DASHES);
    expect(PINTEREST_DAILY_LIMIT_MESSAGE).not.toMatch(DASHES);
  });
});

describe("humanizeErrorMessage: existing behavior is unchanged", () => {
  it("still gives the generic fallback with details for an unrecognised error", () => {
    const { friendly, technical } = humanizeErrorMessage("something odd happened", "pinterest");
    expect(friendly).toBe("This post to Pinterest didn't go through. Technical details are available below if you'd like them.");
    expect(technical).toBe("something odd happened");
  });

  it("still handles a null message", () => {
    expect(humanizeErrorMessage(null, "pinterest")).toEqual({
      friendly: "Something went wrong and no further detail was given.",
      technical: null,
    });
  });

  it("still maps expired tokens and rate limits", () => {
    expect(humanizeErrorMessage("invalid_token", "pinterest").friendly).toContain("needs to be refreshed");
    expect(humanizeErrorMessage("429 too many requests", "pinterest").friendly).toContain("temporarily limiting");
  });
});
