import { describe, it, expect, vi } from "vitest";
import { retryStartupCheck } from "./startupRetry.js";

describe("retryStartupCheck", () => {
  it("returns true at once when the first check passes", async () => {
    const sleep = vi.fn(async () => {});
    const check = vi.fn(async () => ({ ok: true }));
    expect(await retryStartupCheck(check, { sleep })).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("recovers when a later attempt passes, backing off between tries", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    let n = 0;
    const check = async () => (++n < 4 ? { ok: false, error: new Error("timeout") } : { ok: true });
    expect(await retryStartupCheck(check, { sleep, baseDelayMs: 100, maxDelayMs: 1000 })).toBe(true);
    expect(n).toBe(4);
    expect(delays).toEqual([100, 200, 400]);
  });

  it("caps the delay and gives up after the attempt limit", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const check = vi.fn(async () => ({ ok: false, error: "down" }));
    expect(await retryStartupCheck(check, { sleep, attempts: 5, baseDelayMs: 100, maxDelayMs: 300 })).toBe(false);
    expect(check).toHaveBeenCalledTimes(5);
    expect(delays).toEqual([100, 200, 300, 300]);
  });

  it("treats a thrown error as a failed attempt, not a crash", async () => {
    const sleep = async () => {};
    let n = 0;
    const check = async () => {
      if (++n === 1) throw new Error("ConnectTimeoutError");
      return { ok: true };
    };
    expect(await retryStartupCheck(check, { sleep })).toBe(true);
  });
});
