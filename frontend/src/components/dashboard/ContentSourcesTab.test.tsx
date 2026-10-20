import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { ContentSourcesTab } from "./ContentSourcesTab";
import type { ScheduledPost } from "../../lib/api";
import type { ContentSourcesClient } from "../../lib/contentSources";

// The tab is a research page: a short heading, the competitor box first, then the honest status panel. The box itself is a
// stub here (it has its own tests); these tests pin what the tab shows, in what order, and what it must never ask for.

vi.mock("./CompetitorSection", () => ({ default: () => <div data-testid="competitor-box">Paste a competitor link or website</div> }));

afterEach(cleanup);

const DASH = /[\u2013\u2014]/;
const client: ContentSourcesClient = { ready: async () => true };
const pending = { id: "p1", content: "x", status: "pending", paused_at: null, tags: [], social_account_id: "a", scheduled_for: "2026-10-21T08:00:00Z" } as unknown as ScheduledPost;

function show(posts: ScheduledPost[] = []) {
  return render(<ContentSourcesTab posts={posts} client={client} />);
}

describe("ContentSourcesTab", () => {
  it("opens with a plain heading and a one line explanation", () => {
    show();
    expect(screen.getByRole("heading", { level: 2, name: "Competitor research" })).toBeInTheDocument();
    expect(screen.getByText(/paste a link to a competitor/i)).toBeInTheDocument();
  });

  it("puts the competitor box first, before the status panel", () => {
    show();
    const box = screen.getByTestId("competitor-box");
    const status = screen.getByRole("region", { name: "Live status" });
    expect(box.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const parts = [...document.querySelectorAll(".content-sources > *")];
    expect(parts[0]?.tagName).toBe("HEADER");
    expect(parts[1]).toContainElement(box);
  });

  it("shows the status panel from the posts and the service check", async () => {
    show([pending]);
    const status = screen.getByRole("region", { name: "Live status" });
    await waitFor(() => expect(within(status).getByTestId("status-badge")).toHaveTextContent("Running"));
    expect(status).toHaveTextContent("1 scheduled");
  });

  it("never asks for a website, a key, a password or a proof, and has no source list or drafts table", () => {
    show([pending]);
    expect(screen.queryByRole("heading", { name: /add a source/i })).toBeNull();
    expect(screen.queryByLabelText(/feed address|sitemap|api key|lazyrelay key|password/i)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("heading", { name: /drafts for review/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/add a source|verif|domain|api key|password|prove you own|run now|rss|sitemap|csv/i);
    expect(document.body.querySelector("input[type=password]")).toBeNull();
  });

  it("has no em or en dash", () => {
    show();
    expect(document.body.textContent).not.toMatch(DASH);
  });
});
