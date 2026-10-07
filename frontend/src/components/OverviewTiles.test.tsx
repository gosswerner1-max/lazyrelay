import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OverviewPanel, StatTile } from "./Charts";
import type { AnalyticsSummary } from "../lib/api";

const analytics = {
  rangeDays: 30,
  totalPosts: 501,
  byStatus: { posted: 500, failed: 0 },
  byPlatform: { mastodon: { total: 21, posted: 21, failed: 0, verifiedLive: 21 } },
  dailyCounts: { "2026-10-06": 4 },
  verifiedLiveRate: 1,
  engagement: { mastodon: { likes: 0, comments: 1, shares: 4, views: 0, postsWithData: 21 } },
} as unknown as AnalyticsSummary;

// The charts under the tiles ask the browser about reduced motion and size; the test environment has neither.
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

describe("the Overview tiles open the tab behind each number", () => {
  it("Total posts and Verified live open Posts, Failed opens Failed, Total engagement opens Analytics", () => {
    const onOpenTab = vi.fn();
    render(<OverviewPanel analytics={analytics} loading={false} onOpenTab={onOpenTab} />);
    fireEvent.click(screen.getByRole("button", { name: /Total posts/ }));
    fireEvent.click(screen.getByRole("button", { name: /Failed/ }));
    fireEvent.click(screen.getByRole("button", { name: /Verified live/ }));
    fireEvent.click(screen.getByRole("button", { name: /Total engagement/ }));
    expect(onOpenTab.mock.calls.map((c) => c[0])).toEqual(["Posts", "Failed", "Posts", "Analytics"]);
  });

  it("the tiles are plain, non-clickable boxes when no handler is given", () => {
    const { container } = render(<OverviewPanel analytics={analytics} loading={false} />);
    expect(container.querySelectorAll(".chart-stat-tile-link")).toHaveLength(0);
    expect(container.querySelectorAll(".chart-stat-tile").length).toBeGreaterThanOrEqual(4);
  });

  it("a clickable tile says what the click does, for screen readers and as a tooltip", () => {
    render(<StatTile label="Failed" value="3" onClick={() => {}} actionLabel="Open the Failed tab" />);
    const tile = screen.getByRole("button", { name: "Failed: 3. Open the Failed tab" });
    expect(tile.getAttribute("title")).toBe("Open the Failed tab");
  });

  it("a StatTile without onClick stays a div, so other screens are unchanged", () => {
    const { container } = render(<StatTile label="Posts" value="1" />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("div.chart-stat-tile")).not.toBeNull();
  });
});
