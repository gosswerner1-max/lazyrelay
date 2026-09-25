import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { TikTokAdapter } from "./tiktok.js";

// Regression test for the 2026-09-25 platform-wide Telegram-bug audit.
//
// verifyPublished() polls TikTok's real status/fetch endpoint (a genuine
// per-post check, unlike Telegram's hardcoded false) but the poll window
// used to be 5 attempts * 3s = 15s -- confirmed too short against
// LazyRelay's own SUPPORT_KNOWLEDGE.md ("real moderation happens async").
// A genuine success still PROCESSING past that window got verifiedLive:
// false, which scheduler.ts's handleFailure() treats like a real failure
// and reruns post() from scratch -- the same duplicate-post consequence as
// the Telegram bug this audit started from. Widened to 30 attempts * 10s =
// 5 minutes, matching YouTube's own already-proven fix for the identical
// failure shape. These tests use fake timers so a "still processing the
// whole window" case doesn't take 5 real minutes to run.
describe("TikTokAdapter.verifyPublished", () => {
  const adapter = new TikTokAdapter("client-key", "client-secret", "https://example.com/callback");

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reports verified live as soon as TikTok reports PUBLISH_COMPLETE", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["9999"] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.verifyPublished("publish-1", "token");

    expect(result.verifiedLive).toBe(true);
    expect(result.platformPostUrl).toBe("https://www.tiktok.com/@_/video/9999");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through PROCESSING_UPLOAD and succeeds once complete, using the widened window", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: "PROCESSING_UPLOAD" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: "PROCESSING_DOWNLOAD" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] } }) });
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = adapter.verifyPublished("publish-2", "token");
    // Two sleeps stand between the three fetch calls above (10s each with
    // the widened window) -- this would have exceeded the OLD 15s/5-attempt
    // budget by itself, which is exactly the false-timeout this fix closes.
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(result.verifiedLive).toBe(true);
    expect(result.platformPostUrl).toBeNull(); // non-public privacy level, no public id
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports a genuine failure (not stuck in a false-success loop) when TikTok reports FAILED", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { status: "FAILED", fail_reason: "video_no_access" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.verifyPublished("publish-3", "token");

    expect(result.verifiedLive).toBe(false);
    expect(result.errorMessage).toBe("video_no_access");
  });

  it("still times out (verifiedLive: false) if processing genuinely never finishes within the widened 5-minute window", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { status: "PROCESSING_UPLOAD" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = adapter.verifyPublished("publish-4", "token");
    await vi.advanceTimersByTimeAsync(30 * 10_000);
    const result = await resultPromise;

    expect(result.verifiedLive).toBe(false);
    expect(result.errorMessage).toMatch(/timed out/);
    // 30 attempts total (29 sleeps of 10s between them).
    expect(fetchMock).toHaveBeenCalledTimes(30);
  });
});
