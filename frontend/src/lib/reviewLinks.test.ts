import { describe, it, expect } from "vitest";
import { reviewUrl, describeLink, describeComment } from "./reviewLinks";

describe("reviewUrl", () => {
  it("is the page's own origin plus /review/<token>", () => {
    expect(reviewUrl("abc", "https://lazyrelay.com")).toBe("https://lazyrelay.com/review/abc");
    expect(reviewUrl("abc", "https://lazyrelay.com/")).toBe("https://lazyrelay.com/review/abc");
  });
});

describe("describeLink", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  it("says removed and expired plainly", () => {
    expect(describeLink({ status: "revoked", expiresAt: "2026-10-30T00:00:00Z", lastViewedAt: null }, now)).toBe("Removed");
    expect(describeLink({ status: "expired", expiresAt: "2026-09-01T00:00:00Z", lastViewedAt: null }, now)).toBe("Expired");
  });
  it("counts the days left and says whether it was opened", () => {
    expect(describeLink({ status: "active", expiresAt: "2026-10-10T12:00:00Z", lastViewedAt: null }, now)).toBe("Active, expires in 10 days. Not opened yet.");
    expect(describeLink({ status: "active", expiresAt: "2026-10-01T12:00:00Z", lastViewedAt: "2026-09-29T09:00:00Z" }, now)).toMatch(/^Active, expires in 1 day\. Last opened /);
  });
});

describe("describeComment", () => {
  it("names the decision or just the author", () => {
    expect(describeComment({ kind: "approved", authorName: "Sam", body: null })).toBe("Sam approved this post");
    expect(describeComment({ kind: "changes_requested", authorName: "Sam", body: "x" })).toBe("Sam asked for changes");
    expect(describeComment({ kind: "updated", authorName: "Agency", body: "x" })).toBe("Agency updated the post");
    expect(describeComment({ kind: "comment", authorName: "Sam", body: "x" })).toBe("Sam");
  });
});
