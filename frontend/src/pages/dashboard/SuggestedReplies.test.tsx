import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FailedReplySend, ReplyDraft } from "../../lib/api";

// En-dash and em-dash, built from code points so no literal dash sits in this file.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const getReplyDrafts = vi.fn();
const approveReplyDraft = vi.fn();
const discardReplyDraft = vi.fn();
const retryReplyDraft = vi.fn();
vi.mock("../../lib/api", () => ({
  api: {
    getReplyDrafts: (...a: unknown[]) => getReplyDrafts(...a),
    approveReplyDraft: (...a: unknown[]) => approveReplyDraft(...a),
    discardReplyDraft: (...a: unknown[]) => discardReplyDraft(...a),
    retryReplyDraft: (...a: unknown[]) => retryReplyDraft(...a),
  },
}));

const { SuggestedReplies, SuggestedRepliesView } = await import("./SuggestedReplies");

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const draft = (over: Partial<ReplyDraft> = {}): ReplyDraft => ({
  id: "d1",
  status: "pending_review",
  triageCategory: "question",
  draftText: "We open at 9am, Monday to Friday.",
  replyLimit: 300,
  createdAt: new Date().toISOString(),
  expiresAt: inDays(5),
  post: { id: "p1", platform: "bluesky", content: "We open at 9am Monday to Friday.", url: "https://bsky.app/post/1" },
  comment: { id: "c1", author: "maria", text: "What time do you open?", url: null, createdAt: null },
  ...over,
});
const needsInput = (over: Partial<ReplyDraft> = {}) =>
  draft({ id: "d2", status: "needs_input", draftText: null, triageCategory: "sales_question", comment: { id: "c2", author: "tom", text: "Do you gift wrap?", url: null, createdAt: null }, ...over });

const failedSend = (over: Partial<FailedReplySend> = {}): FailedReplySend => ({
  id: "f1",
  replyText: "We open at 9am, Monday to Friday.",
  error: "Mastodon reply failed (HTTP 401)",
  uncertain: false,
  tries: 1,
  decidedAt: new Date().toISOString(),
  post: { id: "p1", platform: "mastodon", content: "We open at 9am.", url: "https://mastodon.social/@x/1" },
  comment: { id: "c1", author: "maria", text: "What time do you open?", url: null, createdAt: null },
  ...over,
});

beforeEach(() => {
  getReplyDrafts.mockReset();
  approveReplyDraft.mockReset();
  discardReplyDraft.mockReset();
  retryReplyDraft.mockReset();
});
afterEach(cleanup);

const noop = () => {};
const view = (over: Partial<Parameters<typeof SuggestedRepliesView>[0]> = {}) =>
  render(
    <SuggestedRepliesView
      drafts={[draft()]} typed={{}} busyId={null} errors={{}} notice={null} waitingToSend={0} failed={[]}
      onType={noop} onApprove={noop} onDiscard={noop} onRetry={noop} onDismiss={noop}
      {...over}
    />,
  );

describe("SuggestedRepliesView", () => {
  it("shows the post, the comment, the suggestion in an editable box, the counter and the expiry", () => {
    view();
    expect(screen.getByRole("heading", { name: /Suggested replies/ })).toBeInTheDocument();
    expect(screen.getByText(/On your post: We open at 9am/)).toBeInTheDocument();
    expect(screen.getByText("maria")).toBeInTheDocument();
    expect(screen.getByText("What time do you open?")).toBeInTheDocument();
    expect(screen.getByText("Question")).toBeInTheDocument();
    const box = screen.getByLabelText("Suggested reply");
    expect(box).toHaveValue("We open at 9am, Monday to Friday.");
    expect(box).toBeEnabled();
    expect(screen.getByText("33 / 300")).toBeInTheDocument();
    expect(screen.getByText("Expires in 4 days")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve reply" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
  });

  it("links to the post safely", () => {
    view();
    const link = screen.getByRole("link", { name: "View post" });
    expect(link).toHaveAttribute("href", "https://bsky.app/post/1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("promises nothing is sent before approval, and the copy has no long dashes", () => {
    const { container } = view({ drafts: [draft(), needsInput()], notice: "Reply approved.", errors: { d1: "Something went wrong." } });
    expect(container.textContent).toMatch(/Nothing goes out until you approve it/);
    expect(container.textContent).not.toMatch(DASHES);
  });

  it("a 'needs input' draft says there is no suggestion, starts empty, and cannot be approved yet", () => {
    view({ drafts: [needsInput()] });
    expect(screen.getByText(/could not suggest a reply/i)).toBeInTheDocument();
    const box = screen.getByLabelText("Your reply");
    expect(box).toHaveValue("");
    expect(box).toHaveAttribute("placeholder", "Write your reply...");
    expect(screen.getByRole("button", { name: "Approve reply" })).toBeDisabled();
    expect(screen.getByText("Sales question")).toBeInTheDocument();
  });

  it("shows what the owner has typed instead of the suggestion", () => {
    view({ typed: { d1: "My own words" } });
    expect(screen.getByLabelText("Suggested reply")).toHaveValue("My own words");
    expect(screen.getByText("12 / 300")).toBeInTheDocument();
  });

  it("a reply over the platform's limit is flagged and cannot be approved", () => {
    view({ typed: { d1: "x".repeat(301) } });
    expect(screen.getByText("301 / 300 (too long)")).toHaveClass("suggested-chars-over");
    expect(screen.getByRole("button", { name: "Approve reply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
  });

  it("an emptied box cannot be approved", () => {
    view({ typed: { d1: "   " } });
    expect(screen.getByRole("button", { name: "Approve reply" })).toBeDisabled();
  });

  it("while one draft is being handled its box and buttons are locked, and others are not", () => {
    view({ drafts: [draft(), needsInput({ draftText: "x" })], busyId: "d1" });
    const [first] = screen.getAllByRole("textbox");
    expect(first).toBeDisabled();
    expect(screen.getByRole("button", { name: "Working..." })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Discard" })[0]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Discard" })[1]).toBeEnabled();
  });

  it("shows an error on its card and a notice at the top", () => {
    view({ errors: { d1: "That reply is too long." }, notice: "Reply approved." });
    expect(screen.getByRole("alert")).toHaveTextContent("That reply is too long.");
    expect(screen.getByText("Reply approved.")).toBeInTheDocument();
  });

  it("says so when there is nothing waiting", () => {
    view({ drafts: [] });
    expect(screen.getByText("No suggested replies waiting.")).toBeInTheDocument();
  });

  it("a comment that is no longer in the cache is explained, and the draft is still reviewable", () => {
    view({ drafts: [draft({ comment: { id: "c1", author: "", text: "", url: null, createdAt: null } })] });
    expect(screen.getByText("This comment is no longer available.")).toBeInTheDocument();
    expect(screen.getByLabelText("Suggested reply")).toHaveValue("We open at 9am, Monday to Friday.");
  });

  it("a draft with no post still shows", () => {
    view({ drafts: [draft({ post: null })] });
    expect(screen.queryByText(/On your post/)).toBeNull();
    expect(screen.getByLabelText("Suggested reply")).toBeInTheDocument();
  });
});

describe("SuggestedReplies (loads and acts)", () => {
  it("draws nothing while the feature is off on the server", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: false, drafts: [] });
    const { container } = render(<SuggestedReplies />);
    await waitFor(() => expect(getReplyDrafts).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing if the list cannot be loaded, and does not crash", async () => {
    getReplyDrafts.mockRejectedValue(new Error("Network down"));
    const { container } = render(<SuggestedReplies />);
    await waitFor(() => expect(getReplyDrafts).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the waiting drafts when the feature is on", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [draft(), needsInput()] });
    render(<SuggestedReplies />);
    expect(await screen.findByText("What time do you open?")).toBeInTheDocument();
    expect(screen.getByText("Do you gift wrap?")).toBeInTheDocument();
    expect(screen.getByText("2")).toHaveClass("suggested-count");
  });

  it("approves a suggestion exactly as written without sending any edited text, then removes the card", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [draft()] });
    approveReplyDraft.mockResolvedValue({ success: true, status: "approved" });
    render(<SuggestedReplies />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve reply" }));
    expect(approveReplyDraft).toHaveBeenCalledWith("d1", null);
    expect(await screen.findByText("Reply approved. LazyRelay will post it shortly.")).toBeInTheDocument();
    expect(screen.queryByText("What time do you open?")).toBeNull();
    expect(screen.getByText("No suggested replies waiting.")).toBeInTheDocument();
    expect(screen.getByText("1 approved reply is waiting to be posted.")).toBeInTheDocument();
  });

  it("approves with the owner's own wording, trimmed", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [draft()] });
    approveReplyDraft.mockResolvedValue({ success: true, status: "approved" });
    render(<SuggestedReplies />);
    const box = await screen.findByLabelText("Suggested reply");
    fireEvent.change(box, { target: { value: "  We open at 9. See you!  " } });
    expect(box).toHaveValue("  We open at 9. See you!  ");
    await userEvent.click(screen.getByRole("button", { name: "Approve reply" }));
    expect(approveReplyDraft).toHaveBeenCalledWith("d1", "We open at 9. See you!");
  });

  it("a 'needs input' draft is approved with what the owner wrote", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [needsInput()] });
    approveReplyDraft.mockResolvedValue({ success: true, status: "approved" });
    render(<SuggestedReplies />);
    const button = await screen.findByRole("button", { name: "Approve reply" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Your reply"), "Yes, we gift wrap for free.");
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(approveReplyDraft).toHaveBeenCalledWith("d2", "Yes, we gift wrap for free.");
  });

  it("discards, tells the owner, and removes only that card", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [draft(), needsInput()] });
    discardReplyDraft.mockResolvedValue({ success: true, status: "discarded" });
    render(<SuggestedReplies />);
    await screen.findByText("What time do you open?");
    await userEvent.click(screen.getAllByRole("button", { name: "Discard" })[0]);
    expect(discardReplyDraft).toHaveBeenCalledWith("d1");
    expect(await screen.findByText("Suggested reply discarded.")).toBeInTheDocument();
    expect(screen.queryByText("What time do you open?")).toBeNull();
    expect(screen.getByText("Do you gift wrap?")).toBeInTheDocument();
  });

  it("a refused approval keeps the card, shows the reason on it, and keeps the owner's text", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [draft()] });
    approveReplyDraft.mockRejectedValue(new Error("A reply must be 2000 characters or fewer."));
    render(<SuggestedReplies />);
    const box = await screen.findByLabelText("Suggested reply");
    fireEvent.change(box, { target: { value: "My own words" } });
    await userEvent.click(screen.getByRole("button", { name: "Approve reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A reply must be 2000 characters or fewer.");
    expect(screen.getByLabelText("Suggested reply")).toHaveValue("My own words");
    expect(screen.getByRole("button", { name: "Approve reply" })).toBeEnabled();
    expect(getReplyDrafts).toHaveBeenCalledTimes(2); // the list was refreshed
  });

  it("a draft somebody else already handled disappears and the reason moves to the notice line", async () => {
    getReplyDrafts.mockResolvedValueOnce({ enabled: true, drafts: [draft(), needsInput()] }).mockResolvedValue({ enabled: true, drafts: [needsInput()] });
    approveReplyDraft.mockRejectedValue(new Error("This draft is no longer waiting for a decision."));
    render(<SuggestedReplies />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Approve reply" }))[0]);
    expect(await screen.findByText("This draft is no longer waiting for a decision.")).toBeInTheDocument();
    expect(screen.queryByText("What time do you open?")).toBeNull();
    expect(screen.getByText("Do you gift wrap?")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the buttons work again after a failure (nothing stays locked)", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [draft()] });
    discardReplyDraft.mockRejectedValueOnce(new Error("Network down")).mockResolvedValueOnce({ success: true, status: "discarded" });
    render(<SuggestedReplies />);
    const discard = await screen.findByRole("button", { name: "Discard" });
    await userEvent.click(discard);
    expect(await screen.findByRole("alert")).toHaveTextContent("Network down");
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled());
  });
});

describe("SuggestedRepliesView: replies that could not be sent, and replies waiting to go out", () => {
  it("says how many approved replies are still waiting to be posted, and nothing when there are none", () => {
    const { rerender } = view({ waitingToSend: 1 });
    expect(screen.getByText("1 approved reply is waiting to be posted.")).toBeInTheDocument();
    rerender(
      <SuggestedRepliesView drafts={[draft()]} typed={{}} busyId={null} errors={{}} notice={null} waitingToSend={3} failed={[]} onType={noop} onApprove={noop} onDiscard={noop} onRetry={noop} onDismiss={noop} />,
    );
    expect(screen.getByText("3 approved replies are waiting to be posted.")).toBeInTheDocument();
    rerender(
      <SuggestedRepliesView drafts={[draft()]} typed={{}} busyId={null} errors={{}} notice={null} waitingToSend={0} failed={[]} onType={noop} onApprove={noop} onDiscard={noop} onRetry={noop} onDismiss={noop} />,
    );
    expect(screen.queryByText(/waiting to be posted/)).toBeNull();
  });

  it("shows nothing about failures when there are none", () => {
    view();
    expect(screen.queryByText(/could not be sent/i)).toBeNull();
  });

  it("shows a failed reply with where it was meant to go, the comment, the wording, the reason, and the two choices", () => {
    view({ drafts: [], failed: [failedSend()] });
    expect(screen.getByRole("heading", { name: /Replies that could not be sent/ })).toBeInTheDocument();
    expect(screen.getByText("maria")).toBeInTheDocument();
    expect(screen.getByText("What time do you open?")).toBeInTheDocument();
    expect(screen.getByText("We open at 9am, Monday to Friday.")).toBeInTheDocument();
    expect(screen.getByText(/Mastodon reply failed \(HTTP 401\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Look at your account first/)).toBeNull();
    expect(screen.getByRole("link", { name: "View post" })).toHaveAttribute("href", "https://mastodon.social/@x/1");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });

  it("an uncertain failure tells the owner to look at the account first and changes the button wording", () => {
    view({
      drafts: [],
      failed: [failedSend({ uncertain: true, error: "LazyRelay could not confirm whether this reply was posted (The request timed out). Check your account before trying again, so it is not posted twice." })],
    });
    expect(screen.getByText("Look at your account first.")).toBeInTheDocument();
    expect(screen.getByText(/Check your account before trying again/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I checked, try again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a failed reply whose comment is gone still shows, without an empty comment box", () => {
    view({ drafts: [], failed: [failedSend({ comment: { id: "c1", author: "", text: "", url: null, createdAt: null } })] });
    expect(screen.getByText("We open at 9am, Monday to Friday.")).toBeInTheDocument();
    expect(document.querySelector(".suggested-failed .suggested-comment")).toBeNull();
  });

  it("locks the buttons of the failed reply being handled", () => {
    view({ drafts: [], failed: [failedSend()], busyId: "f1" });
    expect(screen.getByRole("button", { name: "Working..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  });

  it("shows an error under the failed reply it belongs to", () => {
    view({ drafts: [], failed: [failedSend()], errors: { f1: "Network down" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Network down");
  });

  it("none of the new copy has long dashes", () => {
    const { container } = view({ failed: [failedSend({ uncertain: true }), failedSend({ id: "f2" })], waitingToSend: 2 });
    expect(container.textContent).not.toMatch(DASHES);
  });
});

describe("SuggestedReplies: failed sends and the waiting count", () => {
  it("loads the failed sends and the waiting count with the drafts", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [], failed: [failedSend()], waitingToSend: 2 });
    render(<SuggestedReplies />);
    expect(await screen.findByText("We open at 9am, Monday to Friday.")).toBeInTheDocument();
    expect(screen.getByText("2 approved replies are waiting to be posted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("works with an older answer that has no failed list and no count", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [draft()] });
    render(<SuggestedReplies />);
    expect(await screen.findByText("What time do you open?")).toBeInTheDocument();
    expect(screen.queryByText(/could not be sent/i)).toBeNull();
    expect(screen.queryByText(/waiting to be posted/)).toBeNull();
  });

  it("'Try again' queues the reply again: it leaves the failed list and counts as waiting", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [], failed: [failedSend(), failedSend({ id: "f2", replyText: "Second one" })], waitingToSend: 0 });
    retryReplyDraft.mockResolvedValue({ success: true, status: "approved" });
    render(<SuggestedReplies />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Try again" }))[0]);
    expect(retryReplyDraft).toHaveBeenCalledWith("f1");
    expect(await screen.findByText("Reply queued to be posted again.")).toBeInTheDocument();
    expect(screen.queryByText("We open at 9am, Monday to Friday.")).toBeNull();
    expect(screen.getByText("Second one")).toBeInTheDocument();
    expect(screen.getByText("1 approved reply is waiting to be posted.")).toBeInTheDocument();
  });

  it("'Dismiss' throws the failed reply away", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [], failed: [failedSend()], waitingToSend: 0 });
    discardReplyDraft.mockResolvedValue({ success: true, status: "discarded" });
    render(<SuggestedReplies />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(discardReplyDraft).toHaveBeenCalledWith("f1");
    expect(await screen.findByText("Reply dismissed.")).toBeInTheDocument();
    expect(screen.queryByText(/could not be sent/i)).toBeNull();
  });

  it("a refused retry keeps the card and shows the reason on it", async () => {
    getReplyDrafts.mockResolvedValue({ enabled: true, drafts: [], failed: [failedSend()], waitingToSend: 0 });
    retryReplyDraft.mockRejectedValue(new Error("Network down"));
    render(<SuggestedReplies />);
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Network down");
    expect(screen.getByText("We open at 9am, Monday to Friday.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
  });

  it("a failed reply somebody else already handled disappears and its message moves to the notice line", async () => {
    getReplyDrafts.mockResolvedValueOnce({ enabled: true, drafts: [], failed: [failedSend()], waitingToSend: 0 }).mockResolvedValue({ enabled: true, drafts: [], failed: [], waitingToSend: 1 });
    retryReplyDraft.mockRejectedValue(new Error("This reply is no longer waiting to be tried again."));
    render(<SuggestedReplies />);
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("This reply is no longer waiting to be tried again.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("1 approved reply is waiting to be posted.")).toBeInTheDocument();
  });
});
