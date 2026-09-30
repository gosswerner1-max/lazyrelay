import { describe, it, expect } from "vitest";
import { normalizeSelfReply, shouldSelfReply } from "./selfReply.js";

describe("normalizeSelfReply", () => {
  it("is optional", () => {
    expect(normalizeSelfReply(undefined, undefined, "facebook")).toEqual({ ok: true, value: null });
    expect(normalizeSelfReply("", "", "tiktok")).toEqual({ ok: true, value: null });
  });
  it("needs both fields", () => {
    expect(normalizeSelfReply("Thanks!", undefined, "facebook").ok).toBe(false);
    expect(normalizeSelfReply(undefined, 50, "facebook").ok).toBe(false);
  });
  it("accepts a good pair and trims the text", () => {
    expect(normalizeSelfReply("  Thanks all!  ", "50", "instagram")).toEqual({ ok: true, value: { text: "Thanks all!", atLikes: 50 } });
  });
  it("rejects bad like counts and long text", () => {
    for (const bad of [0, -3, 2.5, "abc", 2_000_000]) expect(normalizeSelfReply("hi", bad, "facebook").ok).toBe(false);
    expect(normalizeSelfReply("x".repeat(2201), 10, "facebook").ok).toBe(false);
  });
  it("is refused on platforms with no comment support", () => {
    const r = normalizeSelfReply("hi", 10, "tiktok");
    expect(r.ok).toBe(false);
  });
});

describe("shouldSelfReply", () => {
  const set = { self_reply_text: "Thanks!", self_reply_at_likes: 50, self_reply_done_at: null };
  it("fires at or above the target, once", () => {
    expect(shouldSelfReply(set, 49)).toBe(false);
    expect(shouldSelfReply(set, 50)).toBe(true);
    expect(shouldSelfReply(set, 500)).toBe(true);
    expect(shouldSelfReply({ ...set, self_reply_done_at: "2026-09-30T10:00:00Z" }, 500)).toBe(false);
  });
  it("never fires with no like data or no reply set", () => {
    expect(shouldSelfReply(set, null)).toBe(false);
    expect(shouldSelfReply({ self_reply_text: null, self_reply_at_likes: null, self_reply_done_at: null }, 100)).toBe(false);
  });
});

import { runSelfReply } from "./selfReply.js";
import { vi } from "vitest";

describe("runSelfReply", () => {
  const due = { self_reply_text: "Thanks!", self_reply_at_likes: 5, self_reply_done_at: null };
  it("sends once and records success", async () => {
    const send = vi.fn(async () => ({ success: true, errorMessage: null }));
    const record = vi.fn(async () => {});
    expect(await runSelfReply(due, 9, send, record)).toBe(true);
    expect(send).toHaveBeenCalledWith("Thanks!");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ error: null }));
  });
  it("does nothing below the target", async () => {
    const send = vi.fn();
    const record = vi.fn();
    expect(await runSelfReply(due, 4, send, record)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
  it("records a refusal or a throw as done-with-error (never retried)", async () => {
    const record = vi.fn(async () => {});
    await runSelfReply(due, 9, async () => ({ success: false, errorMessage: "blocked" }), record);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ error: "blocked" }));
    await runSelfReply(due, 9, async () => { throw new Error("network down"); }, record);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ error: "network down" }));
  });
});
