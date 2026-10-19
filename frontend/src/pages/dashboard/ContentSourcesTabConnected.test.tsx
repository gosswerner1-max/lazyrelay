import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The connector hands the tab's three row actions to the dashboard's own existing handlers, and its two links (API Keys, plans)
// to the dashboard's own tab and billing calls. These tests pin which handler each one reaches, so nothing can grow a path of
// its own. The companion service is a fake here.

const ctx = vi.hoisted(() => ({
  posts: [] as unknown[],
  brands: [{ id: "b1", name: "Acme" }],
  handleEditDraft: vi.fn(),
  handleApprove: vi.fn(),
  handlePromotePlanItem: vi.fn(),
  handleDelete: vi.fn(),
  setTab: vi.fn(),
  setScrollToBillingPending: vi.fn(),
  setPosts: vi.fn(),
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));

const posts = vi.hoisted(() => ({ listScheduledPosts: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: posts }));

const service = vi.hoisted(() => ({
  getCredentials: vi.fn(),
  saveKey: vi.fn(),
  removeKey: vi.fn(),
  listSources: vi.fn(),
  createSource: vi.fn(),
  verifySource: vi.fn(),
  updateSource: vi.fn(),
  deleteSource: vi.fn(),
  runSource: vi.fn(),
}));
vi.mock("../../lib/contentSourcesDefault", () => ({ defaultContentSourcesClient: service }));

import ContentSourcesTabConnected from "./ContentSourcesTabConnected";
import { ContentSourcesError } from "../../lib/contentSources";

const draft = { id: "d1", content: "A draft headline", status: "draft", tags: ["cs:rss:blog"], social_account_id: null, scheduled_for: null };
const dated = { id: "n1", content: "Ready headline", status: "needs_approval", tags: ["cs:sitemap:shop"], social_account_id: "a1", scheduled_for: "2026-11-01T08:00:00Z" };
const undated = { id: "n2", content: "Undated headline", status: "needs_approval", tags: ["cs:csv:list"], social_account_id: null, scheduled_for: null };
const ordinary = { id: "x1", content: "Not ours", status: "draft", tags: [], social_account_id: null, scheduled_for: null };

beforeEach(() => {
  ctx.posts = [draft, dated, undated, ordinary];
  for (const fn of [ctx.handleEditDraft, ctx.handleApprove, ctx.handlePromotePlanItem, ctx.handleDelete, ctx.setTab, ctx.setScrollToBillingPending, ctx.setPosts, posts.listScheduledPosts]) fn.mockReset();
  for (const fn of Object.values(service)) fn.mockReset();
  service.getCredentials.mockResolvedValue({ registered: false, keyHint: null });
  service.listSources.mockResolvedValue([]);
});
afterEach(cleanup);

const row = (title: string) => screen.getByText(title).closest("tr") as HTMLElement;
const ready = () => screen.findByRole("heading", { name: "Add a source" });

describe("ContentSourcesTabConnected", () => {
  it("shows the dashboard's own posts (only the cs: drafts) and brands", async () => {
    render(<ContentSourcesTabConnected />);
    await ready();
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

  it("talks to the companion service through the default client", async () => {
    render(<ContentSourcesTabConnected />);
    await ready();
    expect(service.getCredentials).toHaveBeenCalledTimes(1);
    expect(service.listSources).toHaveBeenCalledTimes(1);
  });

  it("after Run now the dashboard's posts are fetched again by themselves, so the new drafts show without a page reload", async () => {
    const source = { id: "s1", sourceType: "sitemap", sourceUrl: "https://example.com/sitemap.xml", syncInterval: "daily", brandId: null, lastSyncedAt: null, domainVerified: true, verificationMethod: "meta_tag", lastError: null, consecutiveFailures: 0, verificationToken: null };
    service.listSources.mockResolvedValueOnce([source]).mockResolvedValue([{ ...source, lastSyncedAt: "2026-10-19T14:00:00Z" }]);
    service.runSource.mockResolvedValue(undefined);
    const fresh = [{ id: "new1", content: "Fresh draft", status: "draft", tags: ["cs:sitemap:shop"] }];
    posts.listScheduledPosts.mockResolvedValue(fresh);
    render(<ContentSourcesTabConnected />);
    await userEvent.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(ctx.setPosts).toHaveBeenCalledWith(fresh), { timeout: 8000 });
  }, 15000);

  it("the key section's link opens the existing API Keys tab", async () => {
    render(<ContentSourcesTabConnected />);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Go to the API Keys tab" }));
    expect(ctx.setTab).toHaveBeenCalledWith("API Keys");
  });

  it("the plan limit link opens the plan page the dashboard's Upgrade button uses (Settings, scrolled to billing)", async () => {
    service.createSource.mockRejectedValue(new ContentSourcesError("plan_limit"));
    render(<ContentSourcesTabConnected />);
    await ready();
    await userEvent.type(screen.getByLabelText("Feed address"), "https://example.com/feed.xml");
    await userEvent.click(screen.getByRole("button", { name: "Add source" }));
    await userEvent.click(await screen.findByRole("button", { name: "See plans" }));
    expect(ctx.setTab).toHaveBeenCalledWith("Settings");
    expect(ctx.setScrollToBillingPending).toHaveBeenCalledWith(true);
  });
});
