import { describe, it, expect } from "vitest";
import { shouldShowBrandingTag, appendTagWithinBudget } from "./scheduler.js";

describe("shouldShowBrandingTag", () => {
  it("shows the tag for a free-tier account with no explicit opt-out", () => {
    expect(shouldShowBrandingTag("free", true)).toBe(true);
    expect(shouldShowBrandingTag("free", undefined)).toBe(true);
    expect(shouldShowBrandingTag("free", null)).toBe(true);
  });

  it("hides the tag once the account has explicitly opted out, free tier or not", () => {
    expect(shouldShowBrandingTag("free", false)).toBe(false);
  });

  it("never shows the tag on any paid tier, regardless of the column's value", () => {
    for (const tier of ["pro", "business", "enterprise", "agency", "agency_plus"] as const) {
      expect(shouldShowBrandingTag(tier, true)).toBe(false);
      expect(shouldShowBrandingTag(tier, undefined)).toBe(false);
    }
  });
});

describe("appendTagWithinBudget", () => {
  const TAG = "— scheduled via LazyRelay (lazyrelay.com)";

  it("appends the tag on a new line when there's room", () => {
    const result = appendTagWithinBudget("Check out our new feature!", TAG, 300);
    expect(result).toBe(`Check out our new feature!\n\n${TAG}`);
  });

  it("returns just the tag when the base content is empty or null", () => {
    expect(appendTagWithinBudget("", TAG, 300)).toBe(TAG);
    expect(appendTagWithinBudget(null, TAG, 300)).toBe(TAG);
    expect(appendTagWithinBudget("   ", TAG, 300)).toBe(TAG);
  });

  it("never truncates the customer's own content -- drops the tag instead when it doesn't fit", () => {
    const longContent = "x".repeat(290);
    const result = appendTagWithinBudget(longContent, TAG, 300);
    expect(result).toBe(longContent);
    expect(result).not.toContain(TAG);
  });

  it("fits exactly on the boundary", () => {
    const base = "x".repeat(10);
    const budget = base.length + 2 + TAG.length; // "\n\n" is 2 chars
    const result = appendTagWithinBudget(base, TAG, budget);
    expect(result).toBe(`${base}\n\n${TAG}`);
    expect(result.length).toBe(budget);
  });

  it("drops the tag one character over the boundary", () => {
    const base = "x".repeat(10);
    const budget = base.length + 2 + TAG.length - 1;
    const result = appendTagWithinBudget(base, TAG, budget);
    expect(result).toBe(base);
  });
});
