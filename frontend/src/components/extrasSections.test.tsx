// Composer and Settings pieces added for snippets, RSS feeds and posting times,
// rendered for real with the API mocked.

import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnippetPicker } from "./SnippetPicker";
import { RssFeedsSection } from "../pages/dashboard/RssFeedsSection";

const listSnippets = vi.hoisted(() => vi.fn());
const listRssFeeds = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ api: { listSnippets, listRssFeeds, createRssFeed: vi.fn(), setRssFeedEnabled: vi.fn(), deleteRssFeed: vi.fn() } }));

afterEach(() => {
  cleanup();
  listSnippets.mockReset();
  listRssFeeds.mockReset();
});

const snip = (id: string, name: string, content: string, isSignature = false) => ({ id, name, content, isSignature, createdAt: "2026-09-30T10:00:00Z" });

describe("SnippetPicker", () => {
  it("shows nothing until a snippet exists", async () => {
    listSnippets.mockResolvedValue({ maxSnippets: 50, snippets: [] });
    const { container } = render(<SnippetPicker content="" setContent={() => {}} />);
    await waitFor(() => expect(listSnippets).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("inserts a chosen snippet onto its own paragraph, and has an Add signature button", async () => {
    listSnippets.mockResolvedValue({ maxSnippets: 50, snippets: [snip("1", "Hashtags", "#a #b"), snip("2", "Sign-off", "Cheers, Sam", true)] });
    const setContent = vi.fn();
    render(<SnippetPicker content="Big news." setContent={setContent} />);
    await userEvent.click(await screen.findByText("Add signature"));
    expect(setContent).toHaveBeenLastCalledWith("Big news.\n\nCheers, Sam");
    await userEvent.selectOptions(screen.getByLabelText("Insert a saved snippet"), "1");
    expect(setContent).toHaveBeenLastCalledWith("Big news.\n\n#a #b");
  });

  it("stays out of the way if the list cannot load", async () => {
    listSnippets.mockRejectedValue(new Error("offline"));
    const { container } = render(<SnippetPicker content="" setContent={() => {}} />);
    await waitFor(() => expect(listSnippets).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});

describe("RssFeedsSection by plan", () => {
  it("Free: says it is part of the paid plans and offers no add form", async () => {
    listRssFeeds.mockResolvedValue({ maxFeeds: 0, feeds: [] });
    render(<RssFeedsSection onError={() => {}} />);
    expect(await screen.findByText(/part of the paid plans/)).toBeTruthy();
    expect(document.querySelector('input[type="url"]')).toBeNull();
  });

  it("paid: shows the plan's limit, the feeds and the add form", async () => {
    listRssFeeds.mockResolvedValue({
      maxFeeds: 3,
      feeds: [{ id: "f1", url: "https://example.com/feed.xml", label: "Blog", enabled: true, lastCheckedAt: null, lastError: "The feed answered 404." }],
    });
    render(<RssFeedsSection onError={() => {}} />);
    expect(await screen.findByText(/Your plan includes 3 feeds\. You have 1\./)).toBeTruthy();
    expect(screen.getByText("Blog")).toBeTruthy();
    expect(screen.getByText("Problem: The feed answered 404.")).toBeTruthy();
    expect(document.querySelector('input[type="url"]')).not.toBeNull();
  });

  it("at the limit the add button says so and is disabled", async () => {
    listRssFeeds.mockResolvedValue({ maxFeeds: 1, feeds: [{ id: "f1", url: "https://example.com/feed.xml", label: null, enabled: true, lastCheckedAt: "2026-09-30T10:00:00Z", lastError: null }] });
    render(<RssFeedsSection onError={() => {}} />);
    const button = await screen.findByRole("button", { name: "Feed limit reached" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
