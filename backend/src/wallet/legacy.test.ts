import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables } from "../testFakeSupabase.js";

const ctl = vi.hoisted(() => ({ fail: false, reads: 0 }));

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => {
        ctl.reads += 1;
        if (ctl.fail) {
          const b: Record<string, unknown> = {};
          for (const op of ["select", "eq", "maybeSingle"]) b[op] = () => b;
          b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve);
          return b;
        }
        return f.makeBuilder(t);
      },
    },
  };
});

const { isLegacyAccount } = await import("./legacy.js");

beforeEach(() => {
  ctl.fail = false;
  ctl.reads = 0;
  tables.wallet_legacy_accounts = [{ account_id: "old-1" }];
});
afterEach(() => vi.useRealTimers());

describe("isLegacyAccount", () => {
  it("true for an account on the legacy list, false for any other", async () => {
    expect(await isLegacyAccount("old-1")).toBe(true);
    expect(await isLegacyAccount("new-1")).toBe(false);
  });

  it("caches the answer for 60 seconds, then asks again", async () => {
    vi.useFakeTimers();
    await isLegacyAccount("cache-1");
    await isLegacyAccount("cache-1");
    expect(ctl.reads).toBe(1);
    vi.advanceTimersByTime(59_000);
    await isLegacyAccount("cache-1");
    expect(ctl.reads).toBe(1);
    vi.advanceTimersByTime(2_000);
    tables.wallet_legacy_accounts.push({ account_id: "cache-1" });
    expect(await isLegacyAccount("cache-1")).toBe(true);
    expect(ctl.reads).toBe(2);
  });

  it("fails to TRUE (never meter or cap) when the read errors, logs it, and does not cache the failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    ctl.fail = true;
    expect(await isLegacyAccount("err-1")).toBe(true);
    expect(log).toHaveBeenCalled();
    ctl.fail = false;
    expect(await isLegacyAccount("err-1")).toBe(false);
    log.mockRestore();
  });
});
