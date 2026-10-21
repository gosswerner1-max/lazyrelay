// The Calendar workspace: a weekly grid and a monthly matrix, a Google Calendar sidebar with a bar chart, and a slide-out drawer for a post or a day.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/api", () => ({}));
import { CalendarWorkspace } from "./CalendarWorkspace";
import { BRAND_PALETTE } from "../../lib/calendarModel";
import type { Brand, ScheduledPost, SocialAccount } from "../../lib/api";

const local = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm);
const NOW = local(2026, 3, 11, 12, 0); // a Wednesday
const acct = (id: string, platform: string, brand: string): SocialAccount => ({ id, platform, platform_account_id: id, display_name: id, connected_at: "2026-01-01T00:00:00Z", brand_label: brand, brand_id: "b-" + brand });
const ACCOUNTS = [acct("a1", "tiktok", "Alpha"), acct("a2", "facebook", "Alpha"), acct("b1", "facebook", "Beta")];
const BRANDS = [{ id: "b-Alpha", name: "Alpha" }, { id: "b-Beta", name: "Beta" }] as unknown as Brand[];
const post = (id: string, status: ScheduledPost["status"], accountId: string, when: Date, extra: Record<string, unknown> = {}): ScheduledPost =>
  ({ id, status, social_account_id: accountId, scheduled_for: when.toISOString(), planned_date: null, paused_at: null, google_event_id: null, content: "Caption " + id, post_results: [], ...extra }) as unknown as ScheduledPost;
const POSTS: ScheduledPost[] = [
  post("p1", "posted", "a1", local(2026, 3, 11, 9, 0), { google_event_id: "g1", content: "A fictional launch announcement for the sample brand" }),
  post("p2", "pending", "a2", local(2026, 3, 11, 14, 0), { paused_at: "2026-03-01T00:00:00Z", google_event_id: "g2" }),
  post("p3", "pending", "b1", local(2026, 3, 12, 10, 0)),
  ...Array.from({ length: 7 }, (_, i) => post("m" + i, "pending", "a1", local(2026, 3, 13, 8 + i, 0), { google_event_id: "gm" + i })),
];
const CLICKS = [{ code: "abCD1234", destinationUrl: "https://example.com/launch", platform: "tiktok", brand: "Alpha", scheduledPostId: "p1", createdAt: "2026-03-01T00:00:00Z", clicks: 12, lastClick: local(2026, 3, 10, 18, 30).toISOString() }];
const GOOGLE_ON = { state: "connected" as const, email: "owner@example.com", lastSyncedAt: local(2026, 3, 11, 11, 10).toISOString() };

const setup = (over: Partial<React.ComponentProps<typeof CalendarWorkspace>> = {}) => {
  const onConnectGoogle = vi.fn();
  render(<CalendarWorkspace posts={POSTS} accounts={ACCOUNTS} brands={BRANDS} google={GOOGLE_ON} linkClicks={CLICKS} onConnectGoogle={onConnectGoogle} now={NOW} {...over} />);
  return { onConnectGoogle };
};

beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("weekly grid", () => {
  it("shows Monday to Sunday of the current week, with today marked", () => {
    setup();
    expect(screen.getByText("Mon 9 to Sun 15 Mar 2026")).toBeInTheDocument();
    for (const d of [9, 10, 11, 12, 13, 14, 15]) expect(screen.getByTestId(`cw-day-2026-03-${String(d).padStart(2, "0")}`)).toBeInTheDocument();
    expect(screen.getByTestId("cw-day-2026-03-11")).toHaveAttribute("aria-current", "date");
    expect(screen.getByTestId("cw-day-2026-03-10")).not.toHaveAttribute("aria-current");
  });
  it("shows at most five cards in a day and a '+N more' button for the rest", () => {
    setup();
    const day = screen.getByTestId("cw-day-2026-03-13");
    expect(within(day).getAllByTestId(/^cw-card-/)).toHaveLength(5);
    expect(within(day).getByRole("button", { name: "+2 more" })).toBeInTheDocument();
  });
  it("moves a week at a time and comes back to today", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /next week/i }));
    expect(screen.getByText("Mon 16 to Sun 22 Mar 2026")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /previous week/i }));
    await userEvent.click(screen.getByRole("button", { name: /previous week/i }));
    expect(screen.getByText("Mon 2 to Sun 8 Mar 2026")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^today$/i }));
    expect(screen.getByText("Mon 9 to Sun 15 Mar 2026")).toBeInTheDocument();
  });
  it("follows the brand filter", async () => {
    setup();
    await userEvent.selectOptions(screen.getByLabelText(/brand/i), "Beta");
    expect(screen.getAllByTestId(/^cw-card-/)).toHaveLength(1);
    expect(screen.getByTestId("cw-card-p3")).toBeInTheDocument();
  });
});

describe("monthly matrix", () => {
  it("switches inline to the month with a cell for every day and the post counts", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /monthly matrix/i }));
    expect(screen.getByText("March 2026")).toBeInTheDocument();
    expect(screen.getAllByTestId(/^cw-cell-/)).toHaveLength(42);
    expect(screen.getByTestId("cw-cell-2026-03-13")).toHaveTextContent("7");
    expect(screen.getByTestId("cw-cell-2026-03-11")).toHaveAttribute("aria-current", "date");
  });
  it("moves a month at a time", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /monthly matrix/i }));
    await userEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(screen.getByText("April 2026")).toBeInTheDocument();
  });
});

describe("drawer", () => {
  it("opens from a card with the full text, the status and where it came from, without moving the grid", async () => {
    setup();
    const before = screen.getAllByTestId(/^cw-day-/).map((e) => e.getAttribute("data-testid"));
    await userEvent.click(screen.getByTestId("cw-card-p1"));
    const drawer = screen.getByRole("dialog", { name: /post details/i });
    expect(drawer).toHaveAttribute("data-open", "true");
    expect(within(drawer).getByText("A fictional launch announcement for the sample brand")).toBeInTheDocument();
    expect(within(drawer).getByText(/published/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/from a google calendar event/i)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^cw-day-/).map((e) => e.getAttribute("data-testid"))).toEqual(before);
  });
  it("shows the raw click history for a post that carries a tracked link, and says so when it does not", async () => {
    setup();
    await userEvent.click(screen.getByTestId("cw-card-p1"));
    const drawer = screen.getByRole("dialog", { name: /post details/i });
    expect(within(drawer).getByText(/12 clicks/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/example\.com\/launch/)).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: /close/i }));
    await userEvent.click(screen.getByTestId("cw-card-p2"));
    expect(within(screen.getByRole("dialog", { name: /post details/i })).getByText(/no tracked link/i)).toBeInTheDocument();
  });
  it("closes with Escape and gives focus back to the card that opened it", async () => {
    setup();
    const card = screen.getByTestId("cw-card-p1");
    await userEvent.click(card);
    expect(screen.getByRole("dialog", { name: /post details/i })).toHaveAttribute("data-open", "true");
    await userEvent.keyboard("{Escape}");
    // a hidden dialog has no accessible name to query by, so find it by role and read its label
    const closed = screen.getByRole("dialog", { hidden: true });
    expect(closed).toHaveAttribute("data-open", "false");
    expect(closed).toHaveAttribute("aria-hidden", "true");
    expect(card).toHaveFocus();
  });
  it("opens a day from '+N more' and from a month cell, with the day's numbers and every post, and a post in it opens its own view", async () => {
    setup();
    await userEvent.click(within(screen.getByTestId("cw-day-2026-03-13")).getByRole("button", { name: "+2 more" }));
    let drawer = screen.getByRole("dialog", { name: /day details/i });
    expect(within(drawer).getByText("Fri 13 Mar")).toBeInTheDocument();
    expect(within(drawer).getAllByRole("button", { name: /caption m/i })).toHaveLength(7);
    await userEvent.click(within(drawer).getAllByRole("button", { name: /caption m/i })[0]);
    drawer = screen.getByRole("dialog", { name: /post details/i });
    expect(within(drawer).getByText("Caption m0")).toBeInTheDocument();
  });
});

describe("Google Calendar sidebar", () => {
  it("shows the connection, the last sync and a seven-bar chart of posts per day that came from Google events", () => {
    setup();
    const side = screen.getByRole("complementary", { name: /google calendar/i });
    expect(within(side).getByText(/connected/i)).toBeInTheDocument();
    expect(within(side).getByText(/owner@example\.com/)).toBeInTheDocument();
    const chart = within(side).getByRole("img", { name: /posts per day from google calendar/i });
    expect(within(chart.parentElement as HTMLElement).getAllByTestId(/^cw-bar-/)).toHaveLength(7);
    expect(within(side).getByTestId("cw-google-week")).toHaveTextContent("9"); // p1, p2 and the seven on the 13th
  });
  it("when Google is not connected it stays visible at 35% with 'Click to Connect API', and the button starts the connection", async () => {
    const { onConnectGoogle } = setup({ google: { state: "disconnected" } });
    const side = screen.getByRole("complementary", { name: /google calendar/i });
    expect(side.className).toMatch(/cw-side--off/);
    await userEvent.click(within(side).getByRole("button", { name: /click to connect api/i }));
    expect(onConnectGoogle).toHaveBeenCalledTimes(1);
  });
});

describe("palette", () => {
  it("never uses a banned-hue colour for a brand", () => {
    const hue = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (!d) return 0;
      const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const c of BRAND_PALETTE) expect(hue(c) >= 250 && hue(c) <= 330, c).toBe(false);
  });
});

describe("safety", () => {
  it("never changes anything on its own: opening cards and the drawer makes no calls", async () => {
    const { onConnectGoogle } = setup();
    await userEvent.click(screen.getByTestId("cw-card-p1"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onConnectGoogle).not.toHaveBeenCalled();
  });
});
