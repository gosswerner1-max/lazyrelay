import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useContentSources } from "./useContentSources";
import { createMockContentSourcesClient } from "../../lib/contentSourcesMock";
import type { ServiceSource } from "../../lib/contentSources";

const ID = "11111111-2222-4333-8444-555555555555";

const source = (over: Partial<ServiceSource> = {}): ServiceSource => ({
  id: ID,
  sourceType: "sitemap",
  sourceUrl: "https://example.com/sitemap.xml",
  syncInterval: "daily",
  brandId: null,
  lastSyncedAt: null,
  domainVerified: true,
  verificationMethod: "meta_tag",
  lastError: null,
  consecutiveFailures: 0,
  verificationToken: null,
  ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function start(listSources: () => Promise<ServiceSource[]>, onRunFinished = vi.fn()) {
  const client = createMockContentSourcesClient({ listSources, getCredentials: async () => ({ registered: true, keyHint: "07f0" }), runSource: async () => undefined });
  const hook = renderHook(() => useContentSources(client, { onRunFinished }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return { ...hook, client, onRunFinished };
}

describe("after Run now the list and the drafts refresh by themselves", () => {
  it("polls the source list, shows the new sync time, then refreshes the drafts once and stops polling", async () => {
    let calls = 0;
    const list = vi.fn(async () => {
      calls += 1;
      return [source(calls >= 3 ? { lastSyncedAt: "2026-10-19T13:51:43Z" } : {})];
    });
    const { result, onRunFinished } = await start(list);
    expect(result.current.sources[0]?.lastSyncedAt).toBeNull();

    await act(async () => {
      await result.current.runSource(ID);
    });
    expect(onRunFinished).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(result.current.sources[0]?.lastSyncedAt).toBe("2026-10-19T13:51:43Z");
    expect(onRunFinished).toHaveBeenCalledTimes(1);

    const seen = list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(list.mock.calls.length).toBe(seen); // stopped
  });

  it("a run that ends in a problem also stops the polling and refreshes the drafts", async () => {
    let calls = 0;
    const list = vi.fn(async () => {
      calls += 1;
      return [source(calls >= 2 ? { lastError: "parse:not_a_feed", consecutiveFailures: 1 } : {})];
    });
    const { result, onRunFinished } = await start(list);
    await act(async () => {
      await result.current.runSource(ID);
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.sources[0]?.lastError).toBe("parse:not_a_feed");
    expect(onRunFinished).toHaveBeenCalledTimes(1);
  });

  it("gives up after two minutes of no change, refreshes the drafts once, and never keeps polling", async () => {
    const list = vi.fn(async () => [source()]);
    const { result, onRunFinished } = await start(list);
    await act(async () => {
      await result.current.runSource(ID);
      await vi.advanceTimersByTimeAsync(130_000);
    });
    expect(onRunFinished).toHaveBeenCalledTimes(1);
    const seen = list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(list.mock.calls.length).toBe(seen);
  });

  it("stops polling when the tab is closed", async () => {
    const list = vi.fn(async () => [source()]);
    const { result, unmount } = await start(list);
    await act(async () => {
      await result.current.runSource(ID);
    });
    unmount();
    const seen = list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(130_000);
    expect(list.mock.calls.length).toBe(seen);
  });

  it("a failing poll does not break the tab; the next poll still runs", async () => {
    let calls = 0;
    const list = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("network");
      return [source(calls >= 4 ? { lastSyncedAt: "2026-10-19T14:00:00Z" } : {})];
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result, onRunFinished } = await start(list);
    await act(async () => {
      await result.current.runSource(ID);
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.phase.kind).toBe("ready");
    expect(onRunFinished).toHaveBeenCalledTimes(1);
  });
});
