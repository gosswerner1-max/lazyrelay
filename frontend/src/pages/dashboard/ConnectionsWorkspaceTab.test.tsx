// The connected Connections tab: reads accounts, brands, posts and integration status from the dashboard state and only ever switches to Social Platforms.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({}));
vi.mock("../../lib/api", () => ({ api }));
const ctx = vi.hoisted(() => ({
  accounts: [
    { id: "a1", platform: "tiktok", platform_account_id: "a1", display_name: "alpha", connected_at: "2026-09-01", brand_label: "Alpha Brand", brand_id: "b1" },
    { id: "a2", platform: "facebook", platform_account_id: "a2", display_name: "alpha page", connected_at: "2026-09-01", brand_label: "Alpha Brand", brand_id: "b1" },
  ] as unknown[],
  brands: [{ id: "b1", name: "Alpha Brand", voice_profile: null, created_at: "2026-09-01" }],
  posts: [] as unknown[],
  gcalStatus: { last_synced_at: "2026-10-20T10:00:00Z" } as unknown,
  gsheetStatus: null as unknown,
  setTab: vi.fn(),
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));

import { ConnectionsWorkspaceTab } from "./ConnectionsWorkspaceTab";

beforeEach(() => {
  ctx.setTab.mockReset();
  ctx.accounts.length = 2;
});
afterEach(cleanup);

describe("ConnectionsWorkspaceTab", () => {
  it("shows the real accounts from the dashboard state", () => {
    render(<ConnectionsWorkspaceTab />);
    expect(screen.getByTestId("cn-stat-accounts")).toHaveTextContent("2");
    expect(screen.getByTestId("cn-tile-tiktok")).toHaveAttribute("data-connected", "true");
    expect(screen.getByTestId("cn-int-gcal")).toHaveTextContent(/last synced/i);
    expect(screen.getByTestId("cn-int-gsheet")).toHaveTextContent(/not connected/i);
  });
  it("has no Manage connections button and a tile click changes nothing", async () => {
    render(<ConnectionsWorkspaceTab />);
    expect(screen.queryByRole("button", { name: /manage connections/i })).toBeNull();
    await userEvent.click(screen.getByTestId("cn-tile-youtube"));
    expect(ctx.setTab).not.toHaveBeenCalled();
  });
  it("copes with an account that has nothing connected", () => {
    ctx.accounts.length = 0;
    render(<ConnectionsWorkspaceTab />);
    expect(screen.getByText(/no platforms connected yet/i)).toBeInTheDocument();
  });
});
