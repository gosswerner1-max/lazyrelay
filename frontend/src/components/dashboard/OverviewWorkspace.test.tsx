import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ScheduledPost, SocialAccount } from "../../lib/api";
import { OverviewWorkspace } from "./OverviewWorkspace";

vi.mock("../../lib/supabase", () => ({ supabase: {} })); // the real client refuses to start without its address

afterEach(cleanup);

const now = new Date("2026-10-22T12:00:00Z");
const acc = (id: string, brand: string, extra: Partial<SocialAccount> = {}): SocialAccount =>
  ({ id, platform: "bluesky", platform_account_id: id, display_name: id, connected_at: "2026-09-01", brand_label: brand, brand_id: null, ...extra }) as SocialAccount;
const post = (id: string, accountId: string, status: ScheduledPost["status"], when: string, extra: Partial<ScheduledPost> = {}): ScheduledPost =>
  ({ id, social_account_id: accountId, content: `post ${id}`, status, scheduled_for: when, paused_at: null, post_results: [], ...extra }) as ScheduledPost;

const accounts = [acc("a1", "Alpha"), acc("a2", "Beta")];

describe("OverviewWorkspace", () => {
  it("shows what posts next, today, and the lists", () => {
    const posts = [
      post("p1", "a1", "pending", "2026-10-22T13:30:00Z"),
      post("p2", "a1", "posted", "2026-10-22T08:00:00Z", { post_results: [{ verified_live: true, platform_post_url: "https://x.test/1", error_message: null }] }),
    ];
    render(<OverviewWorkspace accounts={accounts} posts={posts} now={now} />);
    expect(screen.getByTestId("ov-next")).toHaveTextContent("in 1 h 30 min");
    expect(screen.getByTestId("ov-today")).toHaveTextContent("1 posted");
    expect(screen.getByTestId("ov-attention")).toHaveTextContent("All clear");
    expect(screen.getByTestId("ov-upcoming")).toHaveTextContent("post p1");
    expect(screen.getByTestId("ov-latest")).toHaveTextContent("post p2");
    expect(screen.getByRole("link", { name: "Live" })).toHaveAttribute("href", "https://x.test/1");
  });

  it("says what needs attention", () => {
    const posts = [post("f1", "a1", "failed", "2026-10-22T09:00:00Z"), post("w1", "a1", "pending", "2026-10-23T09:00:00Z", { paused_at: "2026-10-20T00:00:00Z" })];
    render(<OverviewWorkspace accounts={[acc("a1", "Alpha", { needs_reconnect_at: "2026-10-20T00:00:00Z" })]} posts={posts} now={now} />);
    const tile = screen.getByTestId("ov-attention");
    expect(tile).toHaveTextContent("3 to look at");
    expect(tile).toHaveTextContent("1 failed");
    expect(tile).toHaveTextContent("1 paused");
    expect(tile).toHaveTextContent("1 to reconnect");
  });

  it("narrows to a brand with the pills", async () => {
    const posts = [post("a", "a1", "pending", "2026-10-22T13:00:00Z"), post("b", "a2", "pending", "2026-10-22T14:00:00Z")];
    render(<OverviewWorkspace accounts={accounts} posts={posts} now={now} />);
    expect(screen.getByTestId("ov-upcoming")).toHaveTextContent("post b");
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(screen.getByTestId("ov-upcoming")).toHaveTextContent("post a");
    expect(screen.getByTestId("ov-upcoming")).not.toHaveTextContent("post b");
  });

  it("asks a brand-new customer to connect an account", async () => {
    const onConnect = vi.fn();
    render(<OverviewWorkspace accounts={[]} posts={[]} now={now} onConnect={onConnect} />);
    await userEvent.click(screen.getByRole("button", { name: /connect an account/i }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});
