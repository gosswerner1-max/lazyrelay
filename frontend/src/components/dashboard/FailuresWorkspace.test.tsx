// The Failures workspace: status strip, grouped error tiles with the fix, and a scrollable list of recent retries and failures.
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/api", () => ({}));
import { FailuresWorkspace } from "./FailuresWorkspace";
import type { ScheduledPost, SocialAccount } from "../../lib/api";

const acct = (id: string, platform: string, brand: string | null): SocialAccount => ({
  id, platform, platform_account_id: id, display_name: id, connected_at: "2026-09-01T00:00:00Z", brand_label: brand, brand_id: brand ? "b-" + brand : null,
});
const post = (id: string, status: ScheduledPost["status"], accountId: string, results: { error_message: string | null }[], when = "2026-10-20T10:00:00Z"): ScheduledPost =>
  ({ id, status, social_account_id: accountId, scheduled_for: when, content: "x", post_results: results.map((r) => ({ verified_live: false, platform_post_url: null, ...r })) }) as unknown as ScheduledPost;

const ACCOUNTS = [acct("a1", "tiktok", "Alpha"), acct("a2", "mastodon", "Beta")];
const BAD = [
  post("p1", "failed", "a1", [{ error_message: "Token has expired" }]),
  post("p2", "failed", "a1", [{ error_message: "token has expired" }]),
  post("p3", "posted", "a2", [{ error_message: "Rate limit" }, { error_message: null }]),
  post("p4", "posted", "a2", [{ error_message: null }]),
];

afterEach(cleanup);

describe("status strip", () => {
  it("shows the green all-clear when nothing failed", () => {
    render(<FailuresWorkspace accounts={ACCOUNTS} posts={[BAD[3]]} onOpenFailed={vi.fn()} />);
    expect(screen.getByText("All systems fully operational.")).toBeInTheDocument();
    expect(screen.getByTestId("fc-strip")).toHaveAttribute("data-tone", "ok");
  });
  it("shows a red strip with the failed count when posts failed", () => {
    render(<FailuresWorkspace accounts={ACCOUNTS} posts={BAD} onOpenFailed={vi.fn()} />);
    const strip = screen.getByTestId("fc-strip");
    expect(strip).toHaveAttribute("data-tone", "alert");
    expect(within(strip).getByText(/2 posts failed/i)).toBeInTheDocument();
    expect(screen.queryByText("All systems fully operational.")).not.toBeInTheDocument();
  });
  it("shows failed, recovered and clean-first-time numbers", () => {
    render(<FailuresWorkspace accounts={ACCOUNTS} posts={BAD} onOpenFailed={vi.fn()} />);
    expect(screen.getByTestId("fc-stat-failed")).toHaveTextContent("2");
    expect(screen.getByTestId("fc-stat-recovered")).toHaveTextContent("1");
    // 5 attempts, 2 clean
    expect(screen.getByTestId("fc-stat-clean")).toHaveTextContent("40%");
  });
  it("shows a dash instead of NaN when there are no attempts", () => {
    render(<FailuresWorkspace accounts={[]} posts={[]} onOpenFailed={vi.fn()} />);
    expect(screen.getByTestId("fc-stat-clean")).toHaveTextContent("—");
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});

describe("brand switch", () => {
  it("offers All brands plus each brand and narrows the numbers", async () => {
    render(<FailuresWorkspace accounts={ACCOUNTS} posts={BAD} onOpenFailed={vi.fn()} />);
    const group = screen.getByRole("group", { name: /brand/i });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["All brands", "Alpha", "Beta"]);
    expect(within(group).getByRole("button", { name: "All brands" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(group).getByRole("button", { name: "Beta" }));
    expect(within(group).getByRole("button", { name: "Beta" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("fc-stat-failed")).toHaveTextContent("0");
    expect(screen.getByText("All systems fully operational.")).toBeInTheDocument();
  });
});

describe("What went wrong and the fix", () => {
  it("shows one tile per grouped error with count, message and step", () => {
    render(<FailuresWorkspace accounts={ACCOUNTS} posts={BAD} onOpenFailed={vi.fn()} />);
    const tiles = screen.getAllByTestId("fc-tile");
    expect(tiles).toHaveLength(2);
    expect(within(tiles[0]).getByTestId("fc-tile-count")).toHaveTextContent("2");
    expect(within(tiles[0]).getByText(/needs to be refreshed/i)).toBeInTheDocument();
    expect(within(tiles[0]).getByText(/try reconnecting/i)).toBeInTheDocument();
  });
  it("says 'No corrective step recorded' when the message has no step", () => {
    render(<FailuresWorkspace accounts={ACCOUNTS} posts={[post("p1", "failed", "a1", [{ error_message: "mystery" }])]} onOpenFailed={vi.fn()} />);
    expect(screen.getByText("No corrective step recorded")).toBeInTheDocument();
  });
  it("shows a friendly empty line when there are no errors", () => {
    render(<FailuresWorkspace accounts={ACCOUNTS} posts={[]} onOpenFailed={vi.fn()} />);
    expect(screen.getByText(/nothing has gone wrong/i)).toBeInTheDocument();
  });
});

describe("Recent retries and failures", () => {
  it("lists a row per failed or recovered post and lets only failed posts open the Failed tab", async () => {
    const onOpenFailed = vi.fn();
    render(<FailuresWorkspace accounts={ACCOUNTS} posts={BAD} onOpenFailed={onOpenFailed} />);
    expect(screen.getAllByTestId("fc-row")).toHaveLength(3);
    const buttons = screen.getAllByRole("button", { name: /open in posts/i });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0]);
    expect(onOpenFailed).toHaveBeenCalledTimes(1);
  });
  it("has no retry, duplicate or delete buttons", () => {
    render(<FailuresWorkspace accounts={ACCOUNTS} posts={BAD} onOpenFailed={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /retry|duplicate|delete|post again/i })).not.toBeInTheDocument();
  });
  it("shows a friendly empty line when there is nothing to list", () => {
    render(<FailuresWorkspace accounts={ACCOUNTS} posts={[]} onOpenFailed={vi.fn()} />);
    expect(screen.getByText(/no recent retries or failures/i)).toBeInTheDocument();
  });
  it("draws mastodon in slate", () => {
    render(<FailuresWorkspace accounts={ACCOUNTS} posts={BAD} onOpenFailed={vi.fn()} />);
    expect(document.querySelector(".fc-icon--mono")).not.toBeNull();
  });
});
