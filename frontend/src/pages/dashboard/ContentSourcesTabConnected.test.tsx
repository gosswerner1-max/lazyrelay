import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The connector hands the tab's three row actions to the dashboard's own existing handlers. These tests pin which handler
// each action reaches, so a row action can never grow a path of its own.

const ctx = vi.hoisted(() => ({
  posts: [] as unknown[],
  brands: [{ id: "b1", name: "Acme" }],
  handleEditDraft: vi.fn(),
  handleApprove: vi.fn(),
  handlePromotePlanItem: vi.fn(),
  handleDelete: vi.fn(),
  setTab: vi.fn(),
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));

import ContentSourcesTabConnected from "./ContentSourcesTabConnected";

const draft = { id: "d1", content: "A draft headline", status: "draft", tags: ["cs:rss:blog"], social_account_id: null, scheduled_for: null };
const dated = { id: "n1", content: "Ready headline", status: "needs_approval", tags: ["cs:sitemap:shop"], social_account_id: "a1", scheduled_for: "2026-11-01T08:00:00Z" };
const undated = { id: "n2", content: "Undated headline", status: "needs_approval", tags: ["cs:csv:list"], social_account_id: null, scheduled_for: null };
const ordinary = { id: "x1", content: "Not ours", status: "draft", tags: [], social_account_id: null, scheduled_for: null };

beforeEach(() => {
  ctx.posts = [draft, dated, undated, ordinary];
  for (const fn of [ctx.handleEditDraft, ctx.handleApprove, ctx.handlePromotePlanItem, ctx.handleDelete, ctx.setTab]) fn.mockReset();
});
afterEach(cleanup);

const row = (title: string) => screen.getByText(title).closest("tr") as HTMLElement;

describe("ContentSourcesTabConnected", () => {
  it("shows the dashboard's own posts (only the cs: drafts) and brands", () => {
    render(<ContentSourcesTabConnected />);
    expect(screen.getByText("A draft headline")).toBeInTheDocument();
    expect(screen.queryByText("Not ours")).toBeNull();
    expect([...(screen.getByLabelText("Target brand") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["No brand", "Acme"]);
  });

  it("Review and edit loads the draft into the Posts tab form (the existing draft edit flow)", async () => {
    render(<ContentSourcesTabConnected />);
    await userEvent.click(within(row("A draft headline")).getByRole("button", { name: "Review and edit" }));
    expect(ctx.handleEditDraft).toHaveBeenCalledWith(draft);
    expect(ctx.setTab).toHaveBeenCalledWith("Posts");
  });

  it("Approve on a plain draft uses the existing plan-item promotion (schedules it, or opens the form to pick account and time)", async () => {
    render(<ContentSourcesTabConnected />);
    await userEvent.click(within(row("A draft headline")).getByRole("button", { name: "Approve and move to Calendar" }));
    expect(ctx.handlePromotePlanItem).toHaveBeenCalledWith(draft);
    expect(ctx.handleApprove).not.toHaveBeenCalled();
  });

  it("Approve on a post that already has an account and a time uses the existing approve call", async () => {
    render(<ContentSourcesTabConnected />);
    await userEvent.click(within(row("Ready headline")).getByRole("button", { name: "Approve and move to Calendar" }));
    expect(ctx.handleApprove).toHaveBeenCalledWith("n1");
    expect(ctx.handlePromotePlanItem).not.toHaveBeenCalled();
  });

  it("Approve on an approval post with no account or time cannot be approved yet, so it opens the edit form instead", async () => {
    render(<ContentSourcesTabConnected />);
    await userEvent.click(within(row("Undated headline")).getByRole("button", { name: "Approve and move to Calendar" }));
    expect(ctx.handleApprove).not.toHaveBeenCalled();
    expect(ctx.handleEditDraft).toHaveBeenCalledWith(undated);
    expect(ctx.setTab).toHaveBeenCalledWith("Posts");
  });

  it("Dismiss / purge asks first, then uses the existing delete (without a second question from it)", async () => {
    render(<ContentSourcesTabConnected />);
    await userEvent.click(within(row("A draft headline")).getByRole("button", { name: "Dismiss / purge" }));
    expect(ctx.handleDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete draft" }));
    await waitFor(() => expect(ctx.handleDelete).toHaveBeenCalledWith("d1", false));
  });
});
