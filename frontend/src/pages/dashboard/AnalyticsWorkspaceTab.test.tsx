// The connected Insights tab: reads accounts, brands and posts from the dashboard state and asks the existing analytics endpoint for the numbers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const api = vi.hoisted(() => ({ getAnalyticsSummary: vi.fn() }));
vi.mock("../../lib/api", () => ({ api }));
const ctx = vi.hoisted(() => ({
  accounts: [
    { id: "a1", platform: "tiktok", platform_account_id: "a1", display_name: "alpha", connected_at: "2026-09-01", brand_label: "Alpha Brand", brand_id: "b1" },
    { id: "a2", platform: "facebook", platform_account_id: "a2", display_name: "beta", connected_at: "2026-09-01", brand_label: "Beta Brand", brand_id: "b2" },
  ],
  brands: [
    { id: "b2", name: "Beta Brand", voice_profile: null, created_at: "2026-09-01" },
    { id: "b1", name: "Alpha Brand", voice_profile: null, created_at: "2026-09-01" },
  ],
  posts: [] as unknown[],
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));

import { AnalyticsWorkspaceTab } from "./AnalyticsWorkspaceTab";

const posted = (n: number, failed = 0) => ({
  rangeDays: 30, totalPosts: n * 10, byStatus: { posted: n, failed }, verifiedLiveRate: 0.8, engagement: {}, dailyCounts: {},
  byPlatform: { tiktok: { total: n, posted: n, failed, verifiedLive: Math.floor(n * 0.8) } },
});

beforeEach(() => {
  // Called as (days, brand?): a window twice as long has twice the posts, so the previous period is the same size as the current one.
  api.getAnalyticsSummary.mockReset().mockImplementation(async (days: number, brand?: string) => posted((brand === "Alpha Brand" ? 30 : brand === "Beta Brand" ? 10 : 40) * (days >= 60 || days === 14 ? 2 : 1)));
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(cleanup);

describe("AnalyticsWorkspaceTab", () => {
  it("asks for the current range, the equal period before it, and one summary per brand", async () => {
    render(<AnalyticsWorkspaceTab />);
    await waitFor(() => expect(screen.getByRole("group", { name: "Published" })).toHaveTextContent("40"));
    const calls = api.getAnalyticsSummary.mock.calls.map((c) => [c[0], c[1]]);
    expect(calls).toEqual(expect.arrayContaining([[30, undefined], [60, undefined], [30, "Alpha Brand"], [30, "Beta Brand"]]));
    expect(calls).toHaveLength(4);
  });
  it("shows Published from byStatus.posted with growth worked out from the doubled window", async () => {
    render(<AnalyticsWorkspaceTab />);
    // current 40, doubled 80 => previous 40 => 0%
    await waitFor(() => expect(screen.getByRole("group", { name: "Published" })).toHaveTextContent("0%"));
    expect(within(screen.getByRole("group", { name: "Published" })).getByText("40", { selector: "strong" })).toBeInTheDocument();
  });
  it("puts the brands in the dropdown, sorted, and the per-brand totals in the donut", async () => {
    render(<AnalyticsWorkspaceTab />);
    await waitFor(() => expect(screen.getByRole("img", { name: /posts by brand.*40 published/i })).toBeInTheDocument());
    const options = within(screen.getByLabelText("Brand")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["All brands", "Alpha Brand", "Beta Brand"]);
    expect(screen.getByRole("list", { name: /posts by brand/i })).toHaveTextContent("75%");
  });
  it("refetches when the range or the brand changes", async () => {
    render(<AnalyticsWorkspaceTab />);
    await waitFor(() => expect(screen.getByRole("group", { name: "Published" })).toHaveTextContent("40"));
    api.getAnalyticsSummary.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(api.getAnalyticsSummary).toHaveBeenCalledWith(7, undefined));
    expect(api.getAnalyticsSummary).toHaveBeenCalledWith(14, undefined);
    api.getAnalyticsSummary.mockClear();
    fireEvent.change(screen.getByLabelText("Brand"), { target: { value: "Alpha Brand" } });
    await waitFor(() => expect(api.getAnalyticsSummary).toHaveBeenCalledWith(7, "Alpha Brand"));
    await waitFor(() => expect(screen.getByRole("group", { name: "Published" })).toHaveTextContent("30"));
  });
  it("shows a friendly error and keeps the page when the numbers cannot be loaded", async () => {
    api.getAnalyticsSummary.mockReset().mockRejectedValue(new Error("Network down"));
    render(<AnalyticsWorkspaceTab />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/network down/i);
    expect(screen.getByRole("group", { name: "Published" })).toHaveTextContent("0");
  });
  it("still shows the numbers, with growth N/A, when only the earlier window fails", async () => {
    api.getAnalyticsSummary.mockImplementation(async (days: number, brand?: string) => {
      if (days === 60) throw new Error("slow");
      return posted(brand === "Alpha Brand" ? 30 : brand === "Beta Brand" ? 10 : 40);
    });
    render(<AnalyticsWorkspaceTab />);
    await waitFor(() => expect(screen.getByRole("group", { name: "Published" })).toHaveTextContent("40"));
    expect(screen.getByRole("group", { name: "Published" })).toHaveTextContent("N/A");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
