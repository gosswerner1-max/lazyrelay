import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePolling } from "./usePolling";

// The refresh pattern for the inbox: call again every N seconds while the page is visible, stop when it unmounts or is switched off.
// No websockets (the app has none).

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

describe("usePolling", () => {
  it("calls on the interval, not at once, and stops on unmount", () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => usePolling(fn, 1000, true));
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    unmount();
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does nothing while disabled, and while the page is hidden", () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, false));
    vi.advanceTimersByTime(3000);
    expect(fn).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    renderHook(() => usePolling(fn, 1000, true));
    vi.advanceTimersByTime(3000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("always calls the latest function", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ f }) => usePolling(f, 1000, true), { initialProps: { f: first } });
    rerender({ f: second });
    vi.advanceTimersByTime(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
