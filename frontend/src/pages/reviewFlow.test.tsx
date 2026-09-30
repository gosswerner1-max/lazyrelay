// The client's review page and the owner's pieces, rendered for real with the API mocked.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewPage } from "./ReviewPage";
import { ReviewLinksSection } from "./dashboard/ReviewLinksSection";
import { ReviewThread } from "../components/ReviewThread";
import type { PublicReview } from "../lib/reviewLinks";

const api = vi.hoisted(() => ({
  getPublicReview: vi.fn(),
  reviewApprove: vi.fn(async () => {}),
  reviewRequestChanges: vi.fn(async () => {}),
  reviewComment: vi.fn(async () => {}),
  listReviewLinks: vi.fn(),
  createReviewLink: vi.fn(async () => ({})),
  revokeReviewLink: vi.fn(async () => ({ revoked: true })),
  listReviewComments: vi.fn(),
  addReviewComment: vi.fn(async () => ({})),
  editPostContent: vi.fn(async () => ({})),
}));
vi.mock("../lib/api", () => ({ api }));

const TOKEN = "a".repeat(43);
const review = (over: Partial<PublicReview> = {}): PublicReview => ({
  businessName: "Agency Co",
  label: "Acme review",
  expiresAt: "2026-10-30T00:00:00Z",
  posts: [
    { id: "p1", content: "Summer sale starts Friday", mediaUrl: "https://cdn/a.jpg", mediaUrls: ["https://cdn/b.jpg"], scheduledFor: "2026-10-02T09:00:00Z", platform: "instagram", accountName: "Brand IG", state: "waiting", options: { instagram: { placement: "story" } }, comments: [] },
    { id: "p2", content: "Already approved one", mediaUrl: null, mediaUrls: [], scheduledFor: null, platform: "facebook", accountName: "FB", state: "approved", options: {}, comments: [{ authorKind: "reviewer", authorName: "Sam", kind: "approved", body: null, createdAt: "2026-09-30T10:00:00Z" }] },
  ],
  ...over,
});

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  Object.values(api).forEach((f) => f.mockClear());
});

describe("ReviewPage (the client, no login)", () => {
  it("shows the posts, what is waiting, and keeps the link out of search engines and referrers", async () => {
    api.getPublicReview.mockResolvedValue(review());
    const { unmount } = render(<ReviewPage token={TOKEN} />);
    expect(await screen.findByText("Agency Co: posts to review")).toBeTruthy();
    expect(screen.getByText("Summer sale starts Friday")).toBeTruthy();
    expect(screen.getByText(/1 post is waiting for your approval/)).toBeTruthy();
    expect(screen.getByText("Waiting for your approval")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.getByText(/Instagram Story/)).toBeTruthy();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
    expect(document.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
    unmount();
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });

  it("an invalid or expired link shows one plain message", async () => {
    api.getPublicReview.mockRejectedValue(new Error("This review link isn't valid, or it has expired."));
    render(<ReviewPage token={TOKEN} />);
    expect(await screen.findByText("This review link isn't valid, or it has expired.")).toBeTruthy();
  });

  it("approving needs a name first, then sends it with the name and refreshes", async () => {
    api.getPublicReview.mockResolvedValue(review());
    render(<ReviewPage token={TOKEN} />);
    await userEvent.click(await screen.findByText("Approve"));
    expect(await screen.findByText("Please enter your name at the top first.")).toBeTruthy();
    expect(api.reviewApprove).not.toHaveBeenCalled();
    await userEvent.type(screen.getByPlaceholderText("So the team knows who replied"), "Sam Client");
    await userEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(api.reviewApprove).toHaveBeenCalledWith(TOKEN, "p1", "Sam Client"));
    expect(await screen.findByText("Approved. Thank you.")).toBeTruthy();
    expect(api.getPublicReview).toHaveBeenCalledTimes(2); // reloaded
    expect(localStorage.getItem("lazyrelay.reviewerName")).toBe("Sam Client");
  });

  it("requesting changes needs a comment and sends it", async () => {
    localStorage.setItem("lazyrelay.reviewerName", "Sam");
    api.getPublicReview.mockResolvedValue(review());
    render(<ReviewPage token={TOKEN} />);
    await userEvent.click(await screen.findByText("Request changes"));
    const send = screen.getByText("Send change request") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await userEvent.type(screen.getByPlaceholderText("What should change?"), "Say Saturday");
    await userEvent.click(send);
    await waitFor(() => expect(api.reviewRequestChanges).toHaveBeenCalledWith(TOKEN, "p1", "Sam", "Say Saturday"));
  });

  it("an approved post has no buttons, only its history", async () => {
    api.getPublicReview.mockResolvedValue(review({ posts: [review().posts[1]] }));
    render(<ReviewPage token={TOKEN} />);
    expect(await screen.findByText("Sam approved this post")).toBeTruthy();
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.getByText("Nothing is waiting for you right now.", { exact: false })).toBeTruthy();
  });
});

describe("ReviewLinksSection (the owner)", () => {
  const link = { id: "l1", token: TOKEN, label: "Acme", brandLabel: "Acme", expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), lastViewedAt: null, createdAt: "2026-09-30T10:00:00Z", status: "active" as const };

  it("Free and Starter see an upgrade note and no form", async () => {
    api.listReviewLinks.mockResolvedValue({ maxLinks: 0, links: [] });
    render(<ReviewLinksSection brands={[]} onError={() => {}} />);
    expect(await screen.findByText(/part of the Pro plan and above/)).toBeTruthy();
    expect(screen.queryByText("Create review link")).toBeNull();
  });

  it("shows the plan's limit, the links, and revokes on confirm", async () => {
    api.listReviewLinks.mockResolvedValue({ maxLinks: 3, links: [link] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ReviewLinksSection brands={["Acme", "Zed"]} onError={() => {}} />);
    expect(await screen.findByText(/Your plan includes 3 active links\. You have 1\./)).toBeTruthy();
    expect(screen.getByText(/Not opened yet/)).toBeTruthy();
    await userEvent.click(screen.getByText("Stop this link"));
    await waitFor(() => expect(api.revokeReviewLink).toHaveBeenCalledWith("l1"));
  });

  it("creates a link with the chosen brand and expiry", async () => {
    api.listReviewLinks.mockResolvedValue({ maxLinks: 3, links: [] });
    render(<ReviewLinksSection brands={["Acme"]} onError={() => {}} />);
    await screen.findByText("No active review links.");
    await userEvent.type(screen.getByPlaceholderText(/Who is it for/), "Acme team");
    await userEvent.selectOptions(screen.getByLabelText("Only show posts for one brand (optional)"), "Acme");
    await userEvent.selectOptions(screen.getByLabelText("The link stops working after"), "60");
    await userEvent.click(screen.getByText("Create review link"));
    await waitFor(() => expect(api.createReviewLink).toHaveBeenCalledWith({ label: "Acme team", brandLabel: "Acme", expiresInDays: 60 }));
  });

  it("tucks expired and removed links away behind a button instead of cluttering the list", async () => {
    const old = { ...link, id: "l2", label: "Old test", status: "revoked" as const };
    api.listReviewLinks.mockResolvedValue({ maxLinks: 3, links: [link, old, { ...old, id: "l3", status: "expired" as const }] });
    render(<ReviewLinksSection brands={[]} onError={() => {}} />);
    await screen.findByText(/Your plan includes 3 active links. You have 1./);
    expect(screen.queryByText("Old test")).toBeNull();
    await userEvent.click(screen.getByText("Show 2 old links (expired or removed)"));
    expect(screen.getAllByText("Old test")).toHaveLength(2);
    await userEvent.click(screen.getByText("Hide old links"));
    expect(screen.queryByText("Old test")).toBeNull();
  });

  it("at the limit the create button says so and is disabled", async () => {
    api.listReviewLinks.mockResolvedValue({ maxLinks: 1, links: [link] });
    render(<ReviewLinksSection brands={[]} onError={() => {}} />);
    const b = (await screen.findByRole("button", { name: "Link limit reached" })) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
  });
});

describe("ReviewThread (the owner's side of one post)", () => {
  it("opens on its own when changes were requested, shows the conversation, and can reply and reword", async () => {
    api.listReviewComments.mockResolvedValue({
      comments: [{ id: "c1", authorKind: "reviewer", authorName: "Sam", kind: "changes_requested", body: "Say Saturday", createdAt: "2026-09-30T10:00:00Z" }],
    });
    const onChanged = vi.fn();
    render(<ReviewThread postId="p1" content="Friday sale" changesRequested onChanged={onChanged} onError={() => {}} />);
    expect(await screen.findByText("Sam asked for changes")).toBeTruthy();
    expect(screen.getByText("Say Saturday")).toBeTruthy();
    expect(screen.getByText("Your client asked for changes.")).toBeTruthy();

    await userEvent.type(screen.getByPlaceholderText("Reply to your client"), "On it");
    await userEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(api.addReviewComment).toHaveBeenCalledWith("p1", "On it"));

    await userEvent.click(screen.getByText("Change the wording"));
    const box = screen.getByDisplayValue("Friday sale");
    await userEvent.clear(box);
    await userEvent.type(box, "Saturday sale");
    await userEvent.click(screen.getByText("Save the new wording"));
    await waitFor(() => expect(api.editPostContent).toHaveBeenCalledWith("p1", "Saturday sale"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("stays closed until asked when there is no change request", async () => {
    render(<ReviewThread postId="p1" content="x" changesRequested={false} onChanged={() => {}} onError={() => {}} />);
    expect(api.listReviewComments).not.toHaveBeenCalled();
    api.listReviewComments.mockResolvedValue({ comments: [] });
    await userEvent.click(screen.getByText("Client feedback"));
    expect(await screen.findByText("No feedback from your client yet.")).toBeTruthy();
  });
});
