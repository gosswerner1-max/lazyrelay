import { describe, it, expect, vi, afterEach } from "vitest";
import { LinkedInAdapter } from "./linkedin.js";

// Regression test for the 2026-09-25 platform-wide Telegram-bug audit.
//
// Live curl against LinkedIn (recorded in that audit) confirmed
// verifyPublished()'s public-page fetch cannot actually distinguish "post
// exists" from "post doesn't exist" for any well-formed activity urn --
// LinkedIn login-walls every anonymous request with an identical 307 to
// /signup/cold-join either way, and only a syntactically malformed urn
// 404s. Since platformPostId always comes straight from LinkedIn's own
// x-restli-id header (never malformed), this fetch only ever guards
// against gross malformation, not real removal. These tests lock in the
// CORRECT behavior that follows from that (trust post()'s own confirmed
// success; a non-discriminating weak check must never manufacture a false
// failure) so a future edit doesn't accidentally flip it back to treating
// every LinkedIn post as unverifiable just because anonymous fetches are
// always login-walled.
describe("LinkedInAdapter.verifyPublished", () => {
  const adapter = new LinkedInAdapter("client-id", "client-secret", "https://example.com/callback");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats LinkedIn's real login-wall redirect (307) as verified live, not a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 307 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.verifyPublished("7200000000000000000", "token");

    expect(result.verifiedLive).toBe(true);
    expect(result.errorMessage).toBeNull();
    expect(result.platformPostUrl).toBe("https://www.linkedin.com/feed/update/7200000000000000000/");
  });

  it("still treats a genuine 404 (malformed/garbage id) as a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.verifyPublished("not-a-real-id", "token");

    expect(result.verifiedLive).toBe(false);
    expect(result.errorMessage).toMatch(/404/);
  });

  it("treats an unexpected server error as inconclusive, not verified", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.verifyPublished("123", "token");

    expect(result.verifiedLive).toBe(false);
    expect(result.errorMessage).toMatch(/500/);
  });
});
