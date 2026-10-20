import { describe, expect, it, vi } from "vitest";
import { runWalletExpiryCycle, WALLET_EXPIRY_INTERVAL_MS } from "./expiry.js";

const NOW = new Date("2026-10-21T10:00:00Z");

function build() {
  return {
    expire: vi.fn(async () => ({ expiredLots: 2, expiredMicro: 5_000_000 })),
    expireHolds: vi.fn(async () => ({ expiredHolds: 1 })),
  };
}

describe("wallet expiry cycle", () => {
  it("runs every few minutes", () => {
    expect(WALLET_EXPIRY_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
    expect(WALLET_EXPIRY_INTERVAL_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  it("off: asks the database for nothing", async () => {
    const ledger = build();
    await runWalletExpiryCycle({ ledger, mode: "off", now: NOW, log: vi.fn() });
    expect(ledger.expire).not.toHaveBeenCalled();
    expect(ledger.expireHolds).not.toHaveBeenCalled();
  });

  it.each(["shadow", "on"] as const)("%s: expires lots and stale holds with the given clock", async (mode) => {
    const ledger = build();
    const log = vi.fn();
    await runWalletExpiryCycle({ ledger, mode, now: NOW, log });
    expect(ledger.expire).toHaveBeenCalledWith(NOW);
    expect(ledger.expireHolds).toHaveBeenCalledWith(NOW);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("2 lot(s)"));
  });

  it("a failure in one job is logged, never thrown, and the other job still runs", async () => {
    const ledger = build();
    ledger.expire.mockRejectedValue(new Error("db down 10.0.0.5"));
    const log = vi.fn();
    await expect(runWalletExpiryCycle({ ledger, mode: "on", now: NOW, log })).resolves.toBeUndefined();
    expect(ledger.expireHolds).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("10.0.0.5");
  });
});
