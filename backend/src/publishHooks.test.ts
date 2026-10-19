// The publish hook registry on its own: empty by default, observe-only (deep-frozen copies), failure-safe (a throw or a hang is
// logged and never blocks), concurrent (ten slow handlers cost one timeout), and ids-and-metadata only.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerPublishHook, emitBeforePublish, emitAfterVerify, resetPublishHooks, PUBLISH_HOOK_TIMEOUT_MS } from "./publishHooks.js";

const ctx = { postId: "p1", accountId: "a1", socialAccountId: "s1", platform: "facebook", scheduledFor: "2026-10-19T09:00:00Z", attempt: 1 };
const after = { ...ctx, verifiedLive: true, platformPostId: "fb_1" };

let errors: unknown[][];
beforeEach(() => {
  resetPublishHooks();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPublishHooks();
});

describe("empty by default", () => {
  it("with no handlers both emits resolve at once and clone nothing", async () => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    await expect(emitBeforePublish(ctx)).resolves.toBeUndefined();
    await expect(emitAfterVerify(after)).resolves.toBeUndefined();
    expect(clone).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
  it("the timeout is a named 250 ms", () => {
    expect(PUBLISH_HOOK_TIMEOUT_MS).toBe(250);
  });
});

describe("observe only", () => {
  it("each handler gets its own deep-frozen copy and the caller's object is never touched", async () => {
    const seen: unknown[] = [];
    registerPublishHook("before_publish", "a", (c) => void seen.push(c));
    registerPublishHook("before_publish", "b", (c) => void seen.push(c));
    const original = JSON.parse(JSON.stringify(ctx));
    await emitBeforePublish(ctx);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).not.toBe(ctx);
    for (const s of seen) expect(Object.isFrozen(s)).toBe(true);
    expect(ctx).toEqual(original);
    expect(Object.isFrozen(ctx)).toBe(false);
  });

  it("a handler that tries to change the context throws (frozen), is logged, and the caller's object is unchanged", async () => {
    registerPublishHook("before_publish", "mutator", (c) => {
      (c as { postId: string }).postId = "hacked";
    });
    const original = { ...ctx };
    await emitBeforePublish(ctx);
    expect(ctx).toEqual(original);
    expect(errors).toHaveLength(1);
    expect(errors[0].slice(0, 3)).toEqual(["[publish-hook]", "before_publish", "mutator"]);
  });

  it("a handler that swallows its own mutation error still changes nothing", async () => {
    let seenAfter: unknown;
    registerPublishHook("after_verify", "quiet", (c) => {
      try {
        (c as { verifiedLive: boolean }).verifiedLive = false;
      } catch {
        /* frozen */
      }
      seenAfter = c;
    });
    await emitAfterVerify(after);
    expect((seenAfter as { verifiedLive: boolean }).verifiedLive).toBe(true);
    expect(after.verifiedLive).toBe(true);
  });
});

describe("failure safe", () => {
  it("a throwing handler is logged with point, name and reason, and the others still run", async () => {
    const ran = vi.fn();
    registerPublishHook("before_publish", "bad", () => {
      throw new Error("boom");
    });
    registerPublishHook("before_publish", "good", ran);
    await expect(emitBeforePublish(ctx)).resolves.toBeUndefined();
    expect(ran).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([["[publish-hook]", "before_publish", "bad", "boom"]]);
  });

  it("a rejecting async handler is logged too", async () => {
    registerPublishHook("after_verify", "async-bad", async () => {
      throw new Error("later");
    });
    await emitAfterVerify(after);
    expect(errors).toEqual([["[publish-hook]", "after_verify", "async-bad", "later"]]);
  });

  it("a handler that never answers is cut off at the timeout and logged", async () => {
    vi.useFakeTimers();
    registerPublishHook("before_publish", "hang", () => new Promise<void>(() => {}));
    let done = false;
    const p = emitBeforePublish(ctx).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(PUBLISH_HOOK_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0].slice(0, 3)).toEqual(["[publish-hook]", "before_publish", "hang"]);
    expect(String(errors[0][3])).toMatch(/timed out after 250 ms/);
  });

  it("ten slow handlers run together and cost one timeout, not ten", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) registerPublishHook("after_verify", `slow${i}`, () => new Promise<void>(() => {}));
    let done = false;
    const p = emitAfterVerify(after).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(PUBLISH_HOOK_TIMEOUT_MS);
    await p;
    expect(done).toBe(true);
    expect(errors).toHaveLength(10);
  });

  it("a handler that fails after it was cut off does not become an unhandled rejection, and is logged", async () => {
    vi.useFakeTimers();
    let fail: (e: Error) => void = () => {};
    registerPublishHook("before_publish", "late", () => new Promise<void>((_, reject) => (fail = reject)));
    const p = emitBeforePublish(ctx);
    await vi.advanceTimersByTimeAsync(PUBLISH_HOOK_TIMEOUT_MS);
    await p;
    fail(new Error("too late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.some((e) => String(e[3]).includes("too late"))).toBe(true);
  });

  it("the emit functions never throw, whatever the context holds", async () => {
    registerPublishHook("before_publish", "x", () => {});
    await expect(emitBeforePublish({ ...ctx, scheduledFor: (() => {}) as never })).resolves.toBeUndefined(); // structuredClone cannot copy a function
    expect(errors.length).toBeGreaterThan(0);
  });
});
