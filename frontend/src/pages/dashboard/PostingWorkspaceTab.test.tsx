// The connected Posting workspace tab: reads accounts, brands and posts from the dashboard state and sends through the existing API only when asked.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ saveDraft: vi.fn(), createScheduledPost: vi.fn() }));
vi.mock("../../lib/api", () => ({ api }));
const ctx = vi.hoisted(() => ({
  accounts: [
    { id: "a1", platform: "tiktok", platform_account_id: "a1", display_name: "lazyrelay", connected_at: "2026-09-01", brand_label: "LazyRelay", brand_id: "b1" },
    { id: "a2", platform: "facebook", platform_account_id: "a2", display_name: "LazyRelay page", connected_at: "2026-09-01", brand_label: "LazyRelay", brand_id: "b1" },
  ],
  brands: [{ id: "b1", name: "LazyRelay", voice_profile: null, created_at: "2026-09-01" }],
  posts: [] as unknown[],
  setError: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));

import { PostingWorkspaceTab } from "./PostingWorkspaceTab";

beforeEach(() => {
  api.saveDraft.mockReset().mockResolvedValue({ id: "d1" });
  api.createScheduledPost.mockReset().mockResolvedValue({ id: "s1" });
  ctx.refresh.mockReset().mockResolvedValue(undefined);
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("PostingWorkspaceTab", () => {
  it("makes no API call when it opens", () => {
    render(<PostingWorkspaceTab />);
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(api.createScheduledPost).not.toHaveBeenCalled();
  });
  it("saves a draft through the existing draft API, then refreshes the dashboard", async () => {
    render(<PostingWorkspaceTab />);
    fireEvent.change(screen.getByLabelText(/caption/i), { target: { value: "Draft text" } });
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));
    await waitFor(() => expect(api.saveDraft).toHaveBeenCalledTimes(1));
    expect(api.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ content: "Draft text", plannedAccountIds: expect.arrayContaining(["a1", "a2"]) }));
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });
  it("schedules one post per account through the existing scheduling API", async () => {
    render(<PostingWorkspaceTab />);
    fireEvent.change(screen.getByLabelText(/caption/i), { target: { value: "Go live" } });
    fireEvent.change(screen.getByLabelText(/^date/i), { target: { value: "2026-10-28" } });
    fireEvent.change(screen.getByLabelText(/^time/i), { target: { value: "18:00" } });
    await userEvent.click(screen.getByRole("button", { name: /schedule post/i }));
    await waitFor(() => expect(api.createScheduledPost).toHaveBeenCalledTimes(2));
    const ids = api.createScheduledPost.mock.calls.map((c) => c[0].socialAccountId).sort();
    expect(ids).toEqual(["a1", "a2"]);
    for (const c of api.createScheduledPost.mock.calls) {
      expect(c[0].content).toBe("Go live");
      expect(c[0].scheduledFor).toBe(new Date("2026-10-28T18:00").toISOString());
    }
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });
});
