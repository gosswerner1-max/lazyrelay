import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The shipped wiring with no VITE_CONTENT_SOURCES_API_URL (the test environment has none): the tab says Not connected yet and
// nothing at all goes over the network, not even a request for a LazyRelay session. Only the dashboard's own state is faked.

const getSession = vi.hoisted(() => vi.fn());
vi.mock("../../lib/supabase", () => ({ supabase: { auth: { getSession } } }));
vi.mock("./DashboardContext", () => ({
  useDashboard: () => ({
    posts: [],
    brands: [],
    handleEditDraft: vi.fn(),
    handleApprove: vi.fn(),
    handlePromotePlanItem: vi.fn(),
    handleDelete: vi.fn(),
    setTab: vi.fn(),
    setScrollToBillingPending: vi.fn(),
  }),
}));

import ContentSourcesTabConnected from "./ContentSourcesTabConnected";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ContentSourcesTabConnected without a service address", () => {
  it("shows Not connected yet and makes no network call and no sign in lookup", async () => {
    expect(import.meta.env.VITE_CONTENT_SOURCES_API_URL).toBeUndefined();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<ContentSourcesTabConnected />);
    expect(await screen.findByRole("heading", { name: "Not connected yet" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add a source" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });
});
