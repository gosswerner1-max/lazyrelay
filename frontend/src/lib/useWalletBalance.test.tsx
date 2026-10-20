import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { BalanceResult, Wallet } from "./walletApi";
import { sampleBalance } from "./walletFixtures";

vi.mock("./supabase", () => ({ supabase: {} })); // the real client refuses to start without its address

import { useWalletBalance } from "./useWalletBalance";

const walletWith = (balance: number, exempt = false): Wallet => ({ ...(sampleBalance() as unknown as Wallet), balance, exempt });
const ok = (balance: number, exempt = false): BalanceResult => ({ kind: "ok", wallet: walletWith(balance, exempt) });
const NOW = new Date("2026-10-20T12:00:00Z");

function setup(initial: { enabled?: boolean; checkoutDoneCount?: number }, loadBalance: () => Promise<BalanceResult>) {
  return renderHook((props: { enabled: boolean; checkoutDoneCount: number }) => useWalletBalance({ ...props, loadBalance, now: () => NOW }), {
    initialProps: { enabled: initial.enabled ?? true, checkoutDoneCount: initial.checkoutDoneCount ?? 0 },
  });
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useWalletBalance", () => {
  it("does nothing when billing is off: no request, no timers, nothing active", async () => {
    const load = vi.fn(async () => ok(100));
    const { result, rerender } = setup({ enabled: false }, load);
    rerender({ enabled: false, checkoutDoneCount: 1 });
    await tick(120_000);
    expect(load).not.toHaveBeenCalled();
    expect(result.current.status).toBe("off");
    expect(result.current.billingActive).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("loads once on mount: loading first, then ready with the wallet and the time it was read", async () => {
    const load = vi.fn(async () => ok(100));
    const { result } = setup({}, load);
    expect(result.current.status).toBe("loading");
    expect(result.current.billingActive).toBe(false);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
    expect(result.current.wallet?.balance).toBe(100);
    expect(result.current.fetchedAt).toEqual(NOW);
    expect(result.current.billingActive).toBe(true);
  });

  it("an exempt account is never active and is never polled", async () => {
    const load = vi.fn(async () => ok(100, true));
    const { result, rerender } = setup({}, load);
    await flush();
    expect(result.current.status).toBe("exempt");
    expect(result.current.billingActive).toBe(false);
    rerender({ enabled: true, checkoutDoneCount: 1 });
    await tick(120_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats an unavailable answer (server has billing off) as off, with no error", async () => {
    const { result } = setup({}, async () => ({ kind: "unavailable" }));
    await flush();
    expect(result.current.status).toBe("off");
    expect(result.current.error).toBeNull();
    expect(result.current.billingActive).toBe(false);
  });

  it("keeps a failure as friendly words, stays inactive, and recovers on refresh", async () => {
    const load = vi
      .fn<() => Promise<BalanceResult>>()
      .mockResolvedValueOnce({ kind: "error", message: "We could not load your credits just now. Please try again.", cause: new Error("boom") })
      .mockResolvedValueOnce(ok(40));
    const { result } = setup({}, load);
    await flush();
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("We could not load your credits just now. Please try again.");
    expect(result.current.billingActive).toBe(false);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
    expect(result.current.wallet?.balance).toBe(40);
  });

  it("does not poll for a checkout that was already counted when the page opened", async () => {
    const load = vi.fn(async () => ok(100));
    setup({ checkoutDoneCount: 3 }, load);
    await flush();
    await tick(60_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("after checkout.completed polls every 3 seconds until the balance changes, then stops", async () => {
    const load = vi
      .fn<() => Promise<BalanceResult>>()
      .mockResolvedValueOnce(ok(100))
      .mockResolvedValueOnce(ok(100))
      .mockResolvedValueOnce(ok(100))
      .mockResolvedValue(ok(150));
    const { result, rerender } = setup({}, load);
    await flush();
    rerender({ enabled: true, checkoutDoneCount: 1 });
    await tick(2_999);
    expect(load).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(load).toHaveBeenCalledTimes(2);
    await tick(3_000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(result.current.wallet?.balance).toBe(100);
    await tick(3_000);
    expect(load).toHaveBeenCalledTimes(4);
    expect(result.current.wallet?.balance).toBe(150);
    await tick(60_000);
    expect(load).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up after 60 seconds when the balance never changes (20 checks)", async () => {
    const load = vi.fn(async () => ok(100));
    const { rerender } = setup({}, load);
    await flush();
    rerender({ enabled: true, checkoutDoneCount: 1 });
    await tick(60_000);
    expect(load).toHaveBeenCalledTimes(21);
    await tick(60_000);
    expect(load).toHaveBeenCalledTimes(21);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("two completions close together still run one timer", async () => {
    const load = vi.fn(async () => ok(100));
    const { rerender } = setup({}, load);
    await flush();
    rerender({ enabled: true, checkoutDoneCount: 1 });
    rerender({ enabled: true, checkoutDoneCount: 2 });
    await tick(3_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a failed check while polling does not wipe the wallet and the next check still runs", async () => {
    const load = vi
      .fn<() => Promise<BalanceResult>>()
      .mockResolvedValueOnce(ok(100))
      .mockResolvedValueOnce({ kind: "error", message: "x", cause: new Error("net") })
      .mockResolvedValue(ok(130));
    const { result, rerender } = setup({}, load);
    await flush();
    rerender({ enabled: true, checkoutDoneCount: 1 });
    await tick(3_000);
    expect(result.current.status).toBe("ready");
    expect(result.current.wallet?.balance).toBe(100);
    await tick(3_000);
    expect(result.current.wallet?.balance).toBe(130);
  });

  it("stops everything when the screen goes away", async () => {
    const load = vi.fn(async () => ok(100));
    const { rerender, unmount } = setup({}, load);
    await flush();
    rerender({ enabled: true, checkoutDoneCount: 1 });
    unmount();
    await tick(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refresh reads right away", async () => {
    const load = vi.fn<() => Promise<BalanceResult>>().mockResolvedValueOnce(ok(100)).mockResolvedValueOnce(ok(90));
    const { result } = setup({}, load);
    await flush();
    await act(async () => { await result.current.refresh(); });
    expect(result.current.wallet?.balance).toBe(90);
  });
});
