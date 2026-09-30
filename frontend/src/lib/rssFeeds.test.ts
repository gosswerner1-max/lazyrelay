import { describe, it, expect } from "vitest";
import { describeFeedStatus } from "./rssFeeds";

describe("describeFeedStatus", () => {
  it("says paused first, then a problem, then when it was last checked", () => {
    expect(describeFeedStatus({ enabled: false, lastCheckedAt: null, lastError: "x" })).toBe("Paused");
    expect(describeFeedStatus({ enabled: true, lastCheckedAt: "2026-09-30T10:00:00Z", lastError: "The feed answered 404." })).toBe("Problem: The feed answered 404.");
    expect(describeFeedStatus({ enabled: true, lastCheckedAt: null, lastError: null })).toBe("Not checked yet");
    expect(describeFeedStatus({ enabled: true, lastCheckedAt: "2026-09-30T10:00:00Z", lastError: null })).toMatch(/^Last checked /);
  });
});
