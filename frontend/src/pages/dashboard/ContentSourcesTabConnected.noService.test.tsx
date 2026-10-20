import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// The shipped wiring with no VITE_CONTENT_SOURCES_API_URL (the test environment has none): the box and the status panel both
// show, the service state says Unknown, and nothing at all goes over the network, not even a request for a LazyRelay session.
// Only the dashboard's own state is faked.

const getSession = vi.hoisted(() => vi.fn());
vi.mock("../../lib/supabase", () => ({ supabase: { auth: { getSession } } }));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ({ posts: [] }) }));

import ContentSourcesTabConnected from "./ContentSourcesTabConnected";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ContentSourcesTabConnected without a service address", () => {
  it("shows the box and an Unknown status, and makes no network call and no sign in lookup", () => {
    expect(import.meta.env.VITE_CONTENT_SOURCES_API_URL).toBeUndefined();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<ContentSourcesTabConnected />);
    expect(screen.getByLabelText("Paste a competitor link or website")).toBeInTheDocument();
    const status = screen.getByRole("region", { name: "Live status" });
    expect(within(status).getByTestId("status-badge")).toHaveTextContent("Unknown");
    expect(within(status).getByTestId("service-health")).toHaveTextContent("Unknown");
    expect(screen.queryByRole("heading", { name: "Add a source" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });
});
