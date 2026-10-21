// The connected Calendar tab: reads posts and the Google connection from the dashboard state, fetches link clicks once, and only starts the Google connection on a button press.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ getLinkClicks: vi.fn() }));
vi.mock("../../lib/api", () => ({ api }));
const ctx = vi.hoisted(() => ({
  posts: [] as unknown[],
  accounts: [{ id: "a1", platform: "tiktok", platform_account_id: "a1", display_name: "alpha", connected_at: "2026-09-01", brand_label: "Alpha", brand_id: "b1" }] as unknown[],
  brands: [{ id: "b1", name: "Alpha" }] as unknown[],
  gcalStatus: null as unknown,
  handleConnectGoogleCalendar: vi.fn(),
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));

import { CalendarWorkspaceTab } from "./CalendarWorkspaceTab";

beforeEach(() => {
  api.getLinkClicks.mockReset().mockResolvedValue({ links: [], totals: { clicks: 0 }, days: 90 });
  ctx.handleConnectGoogleCalendar.mockReset();
  ctx.gcalStatus = null;
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("CalendarWorkspaceTab", () => {
  it("asks for link clicks once and starts the Google connection only from the button", async () => {
    render(<CalendarWorkspaceTab />);
    await waitFor(() => expect(api.getLinkClicks).toHaveBeenCalledTimes(1));
    expect(ctx.handleConnectGoogleCalendar).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /click to connect api/i }));
    expect(ctx.handleConnectGoogleCalendar).toHaveBeenCalledTimes(1);
  });
  it("shows the connected email from the dashboard state", async () => {
    ctx.gcalStatus = { connected_email: "owner@example.com", last_synced_at: null };
    render(<CalendarWorkspaceTab />);
    expect(await screen.findByText(/owner@example\.com/)).toBeInTheDocument();
  });
  it("still renders when the click totals cannot be loaded", async () => {
    api.getLinkClicks.mockRejectedValue(new Error("down"));
    render(<CalendarWorkspaceTab />);
    await waitFor(() => expect(api.getLinkClicks).toHaveBeenCalled());
    expect(screen.getByRole("complementary", { name: /google calendar/i })).toBeInTheDocument();
  });
});
