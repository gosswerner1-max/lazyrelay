// The Insights workspace: header with range and brand, three KPI tiles, trend / posting-windows chart, brand donut, channel comparison,
// network health and the proof-of-publish list. Presentational: the parent supplies the numbers. Charts are checked through their accessible summaries.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("../../lib/api", () => ({}));
import { AnalyticsWorkspace } from "./AnalyticsWorkspace";
import type { AnalyticsSummary, ScheduledPost, SocialAccount } from "../../lib/api";

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(cleanup);

const NOW = new Date(2026, 9, 21, 12, 0);
const at = (d: number, h: number) => new Date(2026, 9, d, h, 5).toISOString();
const acct = (id: string, platform: string, brand: string, extra: Partial<SocialAccount> = {}): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: id, connected_at: "2026-01-01T00:00:00Z", brand_label: brand, brand_id: "b-" + brand, ...extra,
});
const ACCOUNTS = [acct("a1", "tiktok", "Alpha Brand"), acct("a2", "mastodon", "Alpha Brand"), acct("a3", "x", "Beta Brand", { needs_reconnect_at: "2026-10-01T00:00:00Z" })];
const verified = (url: string) => [{ verified_live: true, platform_post_url: url, error_message: null }];
const POSTS = [
  { id: "p1", status: "posted", social_account_id: "a1", scheduled_for: at(20, 14), paused_at: null, post_results: verified("https://example.com/p/1") },
  { id: "p2", status: "posted", social_account_id: "a1", scheduled_for: at(13, 14), paused_at: null, post_results: verified("https://example.com/p/2") },
  { id: "p3", status: "posted", social_account_id: "a2", scheduled_for: at(19, 9), paused_at: null, post_results: [] },
] as unknown as ScheduledPost[];
const SUMMARY: AnalyticsSummary = {
  rangeDays: 30, totalPosts: 900, byStatus: { posted: 40, failed: 3, pending: 400 }, verifiedLiveRate: 0.9, engagement: {},
  byPlatform: { tiktok: { total: 30, posted: 25, failed: 1, verifiedLive: 24 }, mastodon: { total: 17, posted: 15, failed: 2, verifiedLive: 12 } },
  dailyCounts: { "2026-10-20": 4, "2026-10-19": 2 },
};

type P = React.ComponentProps<typeof AnalyticsWorkspace>;
const base = (over: Partial<P> = {}): P => ({
  rangeDays: 30, onRangeChange: vi.fn(), brands: ["Alpha Brand", "Beta Brand"], brand: "", onBrandChange: vi.fn(),
  summary: SUMMARY, previous: { published: 20, failed: 0, verifiedLiveRate: 0.45 },
  brandCounts: [{ name: "Alpha Brand", published: 30 }, { name: "Beta Brand", published: 10 }],
  posts: POSTS, accounts: ACCOUNTS, now: NOW, ...over,
});
const setup = (over: Partial<P> = {}) => { const props = base(over); render(<AnalyticsWorkspace {...props} />); return props; };

describe("header", () => {
  it("has a title, three range buttons with the current one pressed, and a brand dropdown starting at All brands", () => {
    setup();
    expect(screen.getByRole("heading", { name: /insights/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "90 days" })).toBeInTheDocument();
    const select = screen.getByLabelText("Brand") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["All brands", "Alpha Brand", "Beta Brand"]);
  });
  it("reports range and brand changes to the parent", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(props.onRangeChange).toHaveBeenCalledWith(7);
    fireEvent.change(screen.getByLabelText("Brand"), { target: { value: "Beta Brand" } });
    expect(props.onBrandChange).toHaveBeenCalledWith("Beta Brand");
  });
});

describe("KPI tiles", () => {
  it("shows Published from byStatus.posted (not the all-status total), the verified live rate and failed posts, each with growth", () => {
    setup();
    const published = screen.getByRole("group", { name: "Published" });
    expect(published).toHaveTextContent("40");
    expect(published).not.toHaveTextContent("900");
    expect(published).toHaveTextContent("+100%");
    const verifiedTile = screen.getByRole("group", { name: "Verified live rate" });
    expect(verifiedTile).toHaveTextContent("90%");
    expect(verifiedTile).toHaveTextContent("+100%");
    const failed = screen.getByRole("group", { name: "Failed posts" });
    expect(failed).toHaveTextContent("3");
    expect(failed).toHaveTextContent("N/A");
  });
  it("shows N/A (never a percentage) when the previous period is unknown", () => {
    setup({ previous: null });
    for (const name of ["Published", "Verified live rate", "Failed posts"]) expect(screen.getByRole("group", { name })).toHaveTextContent("N/A");
  });
});

describe("performance overview", () => {
  it("summarises the daily published line for screen readers and starts on the Trend view", () => {
    setup();
    expect(screen.getByRole("button", { name: "Trend" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("img", { name: /published posts per day.*last 30 days.*6 posts.*busiest day 2026-10-20 with 4/i })).toBeInTheDocument();
  });
  it("switches to the posting-windows heatmap and names the busiest window", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Posting windows" }));
    expect(screen.getByRole("button", { name: "Posting windows" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/busiest window:/i)).toHaveTextContent("Busiest window: Tuesday 14:00 to 15:00 (2 posts)");
    const heat = screen.getByRole("img", { name: /posting windows/i });
    expect(within(heat).getAllByTestId("an-heat-cell")).toHaveLength(7 * 24);
    expect(screen.queryByRole("img", { name: /published posts per day/i })).toBeNull();
  });
  it("does not invent clicks or impressions", () => {
    setup();
    expect(screen.queryByText(/impressions/i)).toBeNull();
    expect(screen.queryByText(/clicks/i)).toBeNull();
  });
});

describe("posts by brand", () => {
  it("shows the total in the donut and a list with percentages", () => {
    setup();
    expect(screen.getByRole("img", { name: /posts by brand.*40 published/i })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: /posts by brand/i });
    expect(within(list).getByText("Alpha Brand")).toBeInTheDocument();
    expect(list).toHaveTextContent("75%");
    expect(list).toHaveTextContent("25%");
  });
});

describe("channel comparison", () => {
  it("lists every platform with its published count, biggest first", () => {
    setup();
    const rows = within(screen.getByRole("list", { name: /channel comparison/i })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("TikTok");
    expect(rows[0]).toHaveTextContent("25");
    expect(rows[1]).toHaveTextContent("Mastodon");
  });
  it("draws the banned-hue brand platforms in slate", () => {
    setup();
    const row = within(screen.getByRole("list", { name: /channel comparison/i })).getByText("Mastodon").closest("li");
    expect(row?.querySelector(".an-mono")).not.toBeNull();
  });
});

describe("active network health", () => {
  it("shows the account total in the ring and the micro-text under it", () => {
    setup();
    expect(screen.getByRole("img", { name: /active network health.*3 accounts/i })).toBeInTheDocument();
    expect(screen.getByText("2 Active / 0 Paused / 1 Errors")).toBeInTheDocument();
  });
});

describe("Proof-of-Publish", () => {
  it("lists verified posts newest first with links that open in a new tab safely", () => {
    setup();
    const links = within(screen.getByRole("list", { name: /proof-of-publish/i })).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["https://example.com/p/1", "https://example.com/p/2"]);
    for (const l of links) {
      expect(l).toHaveAttribute("target", "_blank");
      expect(l.getAttribute("rel")).toContain("noopener");
    }
  });
  it("shows at most 20", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: "m" + i, status: "posted", social_account_id: "a1", scheduled_for: at(1 + (i % 20), 8), paused_at: null, post_results: verified(`https://example.com/p/m${i}`) })) as unknown as ScheduledPost[];
    setup({ posts: many });
    expect(within(screen.getByRole("list", { name: /proof-of-publish/i })).getAllByRole("link")).toHaveLength(20);
  });
});

describe("an empty account", () => {
  it("shows friendly empty states, no crash and no NaN", () => {
    const { container } = render(
      <AnalyticsWorkspace {...base({ summary: null, previous: null, brandCounts: [], brands: [], posts: [], accounts: [] })} />,
    );
    expect(screen.getByText(/no published posts yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no channels have published yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no verified posts yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no accounts connected yet/i)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Published" })).toHaveTextContent("0");
    expect(container.textContent).not.toMatch(/NaN|undefined|Infinity/);
    fireEvent.click(screen.getByRole("button", { name: "Posting windows" }));
    expect(screen.getByText(/no published posts in this range yet/i)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/NaN|undefined|Infinity/);
  });
  it("shows a loading note and an error without hiding the page", () => {
    setup({ loading: true, error: "Could not load analytics." });
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load analytics.");
    expect(screen.getByRole("group", { name: "Published" })).toBeInTheDocument();
  });
});
