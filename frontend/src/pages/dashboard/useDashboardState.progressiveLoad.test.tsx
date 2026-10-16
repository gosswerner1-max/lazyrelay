// The dashboard used to show a spinner until all 14 of its first-load API calls had finished, so the slowest call
// decided when the page appeared. The page now opens as soon as the essential calls (accounts, posts, subscription,
// account, platforms, brands) land, and the slower, non-essential ones (storage, media, add-ons, API keys, recurring
// schedules, team, seats) fill in behind it with their own loading flag.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const slow = vi.hoisted(() => ({} as Record<string, { promise: Promise<unknown>; resolve: (v: unknown) => void }>));
const api = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));

vi.mock("../../lib/api", () => ({ api: new Proxy(api, { get: (t, k: string) => (t[k] ??= vi.fn().mockResolvedValue([])) }) }));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ signOut: vi.fn(), session: { user: { id: "u1" } } }) }));
vi.mock("../../lib/supabase", () => ({
  supabase: { auth: { oauth: { listGrants: vi.fn().mockResolvedValue({ data: [], error: null }) } } },
}));
vi.mock("@paddle/paddle-js", () => ({ initializePaddle: vi.fn().mockResolvedValue(undefined) }));

import { useDashboardState } from "./useDashboardState";

const ESSENTIAL = ["listSocialAccounts", "listScheduledPosts", "getSubscription", "getAccount", "getPlatforms", "getBrands"];
const DEFERRED = ["getStorageUsage", "listMedia", "listStorageAddons", "listApiKeys", "listRecurringSchedules", "getBrandAddons", "listTeam", "getSeatAddons"];

beforeEach(() => {
  for (const k of Object.keys(api)) delete api[k];
  for (const k of Object.keys(slow)) delete slow[k];
  api.listSocialAccounts = vi.fn().mockResolvedValue([]);
  api.listScheduledPosts = vi.fn().mockResolvedValue([]);
  api.getSubscription = vi.fn().mockResolvedValue({ tier: "pro", status: "active" });
  api.getAccount = vi.fn().mockResolvedValue({ businessName: "Shop", voiceProfile: null });
  api.getPlatforms = vi.fn().mockResolvedValue([]);
  api.getBrands = vi.fn().mockResolvedValue([]);
  for (const name of DEFERRED) {
    slow[name] = deferred<unknown>();
    api[name] = vi.fn().mockReturnValue(slow[name].promise);
  }
});
afterEach(cleanup);

describe("dashboard first load", () => {
  it("fires every call at once (no waterfall), essential and deferred alike", async () => {
    renderHook(() => useDashboardState());
    for (const name of [...ESSENTIAL, ...DEFERRED]) expect(api[name]).toHaveBeenCalledTimes(1);
  });

  it("drops the main loading gate before the slow calls resolve", async () => {
    const { result } = renderHook(() => useDashboardState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.deferredLoading).toBe(true);
    expect(result.current.account?.businessName).toBe("Shop");
    expect(result.current.subscription?.tier).toBe("pro");
  });

  it("fills the slow data in once it arrives, then clears the deferred flag", async () => {
    const { result } = renderHook(() => useDashboardState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      slow.getStorageUsage.resolve({ usedBytes: 5, quotaBytes: 10 });
      slow.listMedia.resolve([{ id: "m1" }]);
      slow.listStorageAddons.resolve([]);
      slow.listApiKeys.resolve([{ id: "k1" }]);
      slow.listRecurringSchedules.resolve([]);
      slow.getBrandAddons.resolve({ totalLimit: 3, addonSlots: 0, addons: [] });
      slow.listTeam.resolve([{ user_id: "u1" }]);
      slow.getSeatAddons.resolve({ totalLimit: 1, addonSlots: 0, addons: [] });
    });
    await waitFor(() => expect(result.current.deferredLoading).toBe(false));
    expect(result.current.storageUsage).toEqual({ usedBytes: 5, quotaBytes: 10 });
    expect(result.current.mediaFiles).toHaveLength(1);
    expect(result.current.apiKeys).toHaveLength(1);
    expect(result.current.team).toHaveLength(1);
  });

  it("a failing slow call shows its error and still clears the deferred flag", async () => {
    api.listMedia = vi.fn().mockRejectedValue(new Error("media down"));
    const { result } = renderHook(() => useDashboardState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      for (const name of DEFERRED) slow[name].resolve([]);
    });
    await waitFor(() => expect(result.current.deferredLoading).toBe(false));
    expect(result.current.error).toBe("media down");
  });
});
