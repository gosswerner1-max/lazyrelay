import { afterEach, describe, expect, it, vi } from "vitest";
import { startWalletExpiryJob } from "./expiryJob.js";
import { WALLET_EXPIRY_INTERVAL_MS } from "./expiry.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function client() {
  const calls: string[] = [];
  return {
    calls,
    rpc: async (fn: string) => {
      calls.push(fn);
      return { data: fn === "wallet_expire" ? { expired_lots: 0, expired_micro: 0 } : { expired_holds: 0 }, error: null };
    },
  };
}

describe("startWalletExpiryJob", () => {
  it("calls both SQL expiry functions on every interval when the wallet is on", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WALLET_ENABLED", "true");
    vi.stubEnv("WALLET_MODE", "on");
    const c = client();
    const timer = startWalletExpiryJob(c, () => undefined);
    await vi.advanceTimersByTimeAsync(WALLET_EXPIRY_INTERVAL_MS);
    expect(c.calls).toEqual(["wallet_expire", "wallet_expire_holds"]);
    await vi.advanceTimersByTimeAsync(WALLET_EXPIRY_INTERVAL_MS);
    expect(c.calls).toHaveLength(4);
    clearInterval(timer);
  });

  it("does nothing while the wallet is off (the default)", async () => {
    vi.useFakeTimers();
    const c = client();
    const timer = startWalletExpiryJob(c, () => undefined);
    await vi.advanceTimersByTimeAsync(WALLET_EXPIRY_INTERVAL_MS * 3);
    expect(c.calls).toEqual([]);
    clearInterval(timer);
  });
});
