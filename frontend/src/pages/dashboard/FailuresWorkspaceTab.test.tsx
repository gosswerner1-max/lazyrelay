// The connected Failures tab: reads accounts and posts from the dashboard state and only switches tab; it makes no API call.
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ listFailedPosts: vi.fn(), listScheduledPosts: vi.fn() }));
vi.mock("../../lib/api", () => ({ api }));
const ctx = vi.hoisted(() => ({
  accounts: [{ id: "a1", platform: "tiktok", platform_account_id: "a1", display_name: "x", connected_at: "2026-09-01", brand_label: "Alpha", brand_id: "b1" }],
  posts: [{ id: "p1", status: "failed", social_account_id: "a1", scheduled_for: "2026-10-20T10:00:00Z", content: "x", post_results: [{ verified_live: false, platform_post_url: null, error_message: "Token has expired" }] }] as unknown[],
  setTab: vi.fn(),
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));

import { FailuresWorkspaceTab } from "./FailuresWorkspaceTab";

afterEach(cleanup);

describe("FailuresWorkspaceTab", () => {
  it("shows the dashboard's failed posts and makes no API call", () => {
    render(<FailuresWorkspaceTab />);
    expect(screen.getByTestId("fc-stat-failed")).toHaveTextContent("1");
    expect(api.listFailedPosts).not.toHaveBeenCalled();
    expect(api.listScheduledPosts).not.toHaveBeenCalled();
  });
  it("has no Open in Posts button, because the Failed tab now shows this page", () => {
    render(<FailuresWorkspaceTab />);
    expect(screen.queryByRole("button", { name: /open in posts/i })).toBeNull();
    expect(ctx.setTab).not.toHaveBeenCalled();
  });
});
