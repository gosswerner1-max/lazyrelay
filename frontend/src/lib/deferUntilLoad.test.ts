import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAfterLoadAndIdle, loadScriptAfterLoad } from "./deferUntilLoad";

function setReadyState(state: DocumentReadyState) {
  Object.defineProperty(document, "readyState", { value: state, configurable: true });
}

describe("runAfterLoadAndIdle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setReadyState("complete");
  });

  it("does not run before the window load event", () => {
    setReadyState("loading");
    const cb = vi.fn();
    runAfterLoadAndIdle(cb);
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("runs exactly once after load", () => {
    setReadyState("loading");
    const cb = vi.fn();
    runAfterLoadAndIdle(cb);
    setReadyState("complete");
    window.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(10_000);
    window.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("runs without waiting for a load event when the document is already complete", () => {
    setReadyState("complete");
    const cb = vi.fn();
    runAfterLoadAndIdle(cb);
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("uses requestIdleCallback with a 2 second timeout when it exists", () => {
    setReadyState("complete");
    const ric = vi.fn((fn: () => void) => fn());
    vi.stubGlobal("requestIdleCallback", ric);
    const cb = vi.fn();
    runAfterLoadAndIdle(cb);
    expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: 2000 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("falls back to setTimeout when requestIdleCallback is missing", () => {
    setReadyState("complete");
    vi.stubGlobal("requestIdleCallback", undefined);
    const cb = vi.fn();
    runAfterLoadAndIdle(cb);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("loadScriptAfterLoad", () => {
  afterEach(() => {
    vi.useRealTimers();
    setReadyState("complete");
    document.head.innerHTML = "";
  });

  it("adds the script only after load, and only once per URL", () => {
    vi.useFakeTimers();
    setReadyState("loading");
    const url = "https://example.test/a.js";
    loadScriptAfterLoad(url);
    loadScriptAfterLoad(url);
    expect(document.querySelectorAll(`script[src="${url}"]`)).toHaveLength(0);
    setReadyState("complete");
    window.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(10_000);
    expect(document.querySelectorAll(`script[src="${url}"]`)).toHaveLength(1);
    loadScriptAfterLoad(url);
    vi.advanceTimersByTime(10_000);
    expect(document.querySelectorAll(`script[src="${url}"]`)).toHaveLength(1);
  });
});
