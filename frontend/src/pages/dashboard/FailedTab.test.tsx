import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  listFailedPosts: vi.fn(),
  listScheduledPosts: vi.fn(),
  duplicateScheduledPost: vi.fn(),
  updateDraft: vi.fn(),
  deleteScheduledPost: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

const ctx = vi.hoisted(() => ({
  accounts: [{ id: "a1", platform: "threads", display_name: "Shop", platform_account_id: "x" }],
  setPosts: vi.fn(),
  setError: vi.fn(),
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));

import { FailedTab } from "./FailedTab";

const post = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  social_account_id: "a1",
  content: "Original text",
  status: "failed",
  scheduled_for: "2026-10-01T08:00:00Z",
  post_results: [{ error_message: "The platform said no.", raw_error_message: null, verified_live: false }],
  ...over,
});

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  ctx.setPosts.mockReset();
  ctx.setError.mockReset();
  api.listFailedPosts.mockResolvedValue([post()]);
  api.listScheduledPosts.mockResolvedValue([]);
  api.duplicateScheduledPost.mockResolvedValue({ id: "copy1" });
  api.updateDraft.mockResolvedValue({ id: "copy1" });
  api.deleteScheduledPost.mockResolvedValue(null);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("FailedTab", () => {
  it("lists only what the failed query returns, with the reason", async () => {
    render(<FailedTab />);
    expect(await screen.findByText("Original text")).toBeInTheDocument();
    expect(screen.getByText(/Not confirmed:/)).toBeInTheDocument();
    expect(api.listFailedPosts).toHaveBeenCalled();
  });

  it("says so when nothing failed", async () => {
    api.listFailedPosts.mockResolvedValue([]);
    render(<FailedTab />);
    expect(await screen.findByText(/No failed posts/)).toBeInTheDocument();
  });

  it("posts again: copies first, deletes the failed original only afterwards", async () => {
    render(<FailedTab />);
    await userEvent.click(await screen.findByRole("button", { name: "Post again now" }));
    await waitFor(() => expect(api.deleteScheduledPost).toHaveBeenCalledWith("p1"));
    expect(api.duplicateScheduledPost).toHaveBeenCalledWith("p1", expect.any(String));
    expect(api.duplicateScheduledPost.mock.invocationCallOrder[0]).toBeLessThan(api.deleteScheduledPost.mock.invocationCallOrder[0]);
    await waitFor(() => expect(screen.queryByTestId("failed-post")).toBeNull());
  });

  it("does nothing when the customer cancels the confirm", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<FailedTab />);
    await userEvent.click(await screen.findByRole("button", { name: "Post again now" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(api.duplicateScheduledPost).not.toHaveBeenCalled();
    expect(api.deleteScheduledPost).not.toHaveBeenCalled();
  });

  it("deletes after confirming", async () => {
    render(<FailedTab />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteScheduledPost).toHaveBeenCalledWith("p1"));
    expect(api.duplicateScheduledPost).not.toHaveBeenCalled();
  });

  it("saves edited text onto the copy, then removes the original", async () => {
    render(<FailedTab />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit or reschedule" }));
    const box = screen.getByLabelText("Post text");
    await userEvent.clear(box);
    await userEvent.type(box, "Fixed text");
    await userEvent.click(screen.getByRole("button", { name: "Save and schedule" }));
    await waitFor(() => expect(api.deleteScheduledPost).toHaveBeenCalledWith("p1"));
    expect(api.updateDraft).toHaveBeenCalledWith("copy1", { content: "Fixed text" });
  });

  it("keeps the original and removes the copy if the edit cannot be saved", async () => {
    api.updateDraft.mockRejectedValue(new Error("Too long for this platform."));
    render(<FailedTab />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit or reschedule" }));
    const box = screen.getByLabelText("Post text");
    await userEvent.clear(box);
    await userEvent.type(box, "Fixed text");
    await userEvent.click(screen.getByRole("button", { name: "Save and schedule" }));
    await waitFor(() => expect(ctx.setError).toHaveBeenCalledWith("Too long for this platform."));
    expect(api.deleteScheduledPost).toHaveBeenCalledWith("copy1");
    expect(api.deleteScheduledPost).not.toHaveBeenCalledWith("p1");
    expect(screen.getByTestId("failed-post")).toBeInTheDocument();
  });
});
