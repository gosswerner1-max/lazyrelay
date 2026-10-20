import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

// The connector gives the tab the dashboard's own posts (for the queue state) and the default service client (for the
// readiness check). The competitor box is a stub here. The service client is a fake: nothing touches a network.

const ctx = vi.hoisted(() => ({ posts: [] as unknown[] }));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));

const service = vi.hoisted(() => ({ ready: vi.fn() }));
vi.mock("../../lib/contentSourcesDefault", () => ({ defaultContentSourcesClient: service }));
vi.mock("../../components/dashboard/CompetitorSection", () => ({ default: () => <div data-testid="competitor-box" /> }));

import ContentSourcesTabConnected from "./ContentSourcesTabConnected";

afterEach(() => {
  cleanup();
  ctx.posts = [];
  service.ready.mockReset();
});

describe("ContentSourcesTabConnected", () => {
  it("shows the competitor box and a status panel read from the dashboard's own posts and the service", async () => {
    ctx.posts = [{ id: "p1", content: "x", status: "pending", paused_at: null, tags: [], social_account_id: "a", scheduled_for: "2026-11-01T08:00:00Z" }];
    service.ready.mockResolvedValue(true);
    render(<ContentSourcesTabConnected />);
    expect(screen.getByTestId("competitor-box")).toBeInTheDocument();
    const status = screen.getByRole("region", { name: "Live status" });
    await waitFor(() => expect(within(status).getByTestId("status-badge")).toHaveTextContent("Running"));
    expect(status).toHaveTextContent("1 scheduled");
    expect(service.ready).toHaveBeenCalledTimes(1);
  });

  it("says Problem and Not reachable when the service does not answer", async () => {
    service.ready.mockResolvedValue(false);
    render(<ContentSourcesTabConnected />);
    const status = screen.getByRole("region", { name: "Live status" });
    await waitFor(() => expect(within(status).getByTestId("status-badge")).toHaveTextContent("Problem"));
    expect(within(status).getByTestId("service-health")).toHaveTextContent("Not reachable");
  });
});
