import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Two-way WhatsApp in the dashboard: the inbox, a conversation with its 24 hour window state, free-form replies only while the window
// is open (a template outside it), approval requests with Approve / Request changes / Question buttons, the approvals view, and saved
// audiences with short update lines. The API is a mock; no real number exists anywhere (people are a mask and a name).

const api = vi.hoisted(() => ({
  listWhatsAppConversations: vi.fn(),
  getWhatsAppThread: vi.fn(),
  markWhatsAppConversationRead: vi.fn(),
  replyWhatsApp: vi.fn(),
  sendWhatsAppTemplate: vi.fn(),
  sendWhatsAppApprovalRequest: vi.fn(),
  startWhatsAppConversation: vi.fn(),
  startWhatsAppDirectChat: vi.fn(),
  listWhatsAppTemplates: vi.fn(),
  listWhatsAppContacts: vi.fn(),
  listWhatsAppApprovals: vi.fn(),
  listWhatsAppAudiences: vi.fn(),
  createWhatsAppAudience: vi.fn(),
  deleteWhatsAppAudience: vi.fn(),
  addWhatsAppAudienceMembers: vi.fn(),
  sendWhatsAppAudienceUpdate: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

import { WhatsAppInbox } from "./WhatsAppInbox";
import { WhatsAppApprovals } from "./WhatsAppApprovals";
import { WhatsAppAudiences } from "./WhatsAppAudiences";
import type { WhatsAppChatMessage, WhatsAppContact, WhatsAppConversation, WhatsAppTemplate } from "../../lib/api";

const SA1 = "11111111-1111-4111-8111-111111111111";
const LONG_DIGIT_RUN = /(?:\d[\s().-]?){7,}/;
const OPEN = { open: true, expiresAt: "2026-10-17T10:00:00.000Z", hoursLeft: 5 };
const CLOSED = { open: false, expiresAt: null, hoursLeft: 0 };

const conv = (over: Partial<WhatsAppConversation> = {}): WhatsAppConversation => ({
  id: "c1",
  socialAccountId: SA1,
  contactDisplay: "+27 ** *** 0001",
  displayName: "Pablo",
  isContact: true,
  unreadCount: 2,
  lastMessageAt: "2026-10-16T10:00:00.000Z",
  window: OPEN,
  ...over,
});
const msg = (over: Partial<WhatsAppChatMessage> = {}): WhatsAppChatMessage => ({
  id: "m1",
  direction: "inbound",
  kind: "text",
  text: "Is my logo ready?",
  status: "received",
  failureReason: null,
  occurredAt: "2026-10-16T09:00:00.000Z",
  handedOffAt: null,
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  templateName: null,
  approval: null,
  ...over,
});
const template = (over: Partial<WhatsAppTemplate> = {}): WhatsAppTemplate => ({
  id: "t1",
  name: "project_update",
  language: "en_US",
  category: "utility",
  status: "approved",
  bodyText: "Hi {{1}}, your project is {{2}}",
  variableCount: 2,
  supported: true,
  unsupportedReason: null,
  usable: true,
  syncedAt: null,
  ...over,
});
const contact = (over: Partial<WhatsAppContact> = {}): WhatsAppContact => ({
  id: "k1",
  socialAccountId: SA1,
  contactKey: "a".repeat(64),
  contactDisplay: "+27 ** *** 1111",
  displayName: "Thandi",
  countryCallingCode: "27",
  consentStatus: "opted_in",
  optedInAt: "2026-10-01T00:00:00.000Z",
  optedOutAt: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  ...over,
});

function mockThread(window: WhatsAppConversation["window"] = OPEN, messages: WhatsAppChatMessage[] = [msg()], c: Partial<WhatsAppConversation> = {}) {
  api.getWhatsAppThread.mockResolvedValue({ conversation: conv({ window, ...c }), messages });
}

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listWhatsAppConversations.mockResolvedValue({ conversations: [conv()], nextBefore: null });
  api.listWhatsAppTemplates.mockResolvedValue({ templates: [template()] });
  api.listWhatsAppContacts.mockResolvedValue({ contacts: [contact()], nextBefore: null });
  api.markWhatsAppConversationRead.mockResolvedValue({ ok: true });
  mockThread();
});

describe("inbox", () => {
  it("lists conversations by name or mask with the unread count and the window state, and never a number", async () => {
    api.listWhatsAppConversations.mockResolvedValue({ conversations: [conv(), conv({ id: "c2", displayName: null, contactDisplay: "+27 ** *** 0002", unreadCount: 0, window: CLOSED, isContact: false })], nextBefore: null });
    const { container } = render(<WhatsAppInbox socialAccountId={SA1} />);
    expect(await screen.findByText("Pablo")).toBeInTheDocument();
    expect(screen.getByText("+27 ** *** 0002")).toBeInTheDocument();
    expect(screen.getByLabelText(/2 unread/i)).toBeInTheDocument();
    expect(screen.getAllByText("Open, 5 hours left").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Closed, template required").length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(LONG_DIGIT_RUN);
  });

  it("says what to expect when it is empty", async () => {
    api.listWhatsAppConversations.mockResolvedValue({ conversations: [], nextBefore: null });
    render(<WhatsAppInbox socialAccountId={SA1} />);
    expect(await screen.findByText(/no conversations yet/i)).toBeInTheDocument();
  });

  it("opens a conversation, shows the thread, and marks it read", async () => {
    const user = userEvent.setup();
    render(<WhatsAppInbox socialAccountId={SA1} />);
    await user.click(await screen.findByRole("button", { name: /pablo/i }));
    expect(await screen.findByText("Is my logo ready?")).toBeInTheDocument();
    expect(api.getWhatsAppThread).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(api.markWhatsAppConversationRead).toHaveBeenCalledWith("c1"));
  });

  it("starts a chat with a saved contact and opens it", async () => {
    const user = userEvent.setup();
    api.startWhatsAppConversation.mockResolvedValue({ conversationId: "c9", created: true, window: CLOSED });
    mockThread(CLOSED, [], { id: "c9", displayName: "Thandi", unreadCount: 0 });
    render(<WhatsAppInbox socialAccountId={SA1} />);
    await screen.findByText("Pablo");
    await user.selectOptions(screen.getByLabelText(/pick a saved contact/i), "k1");
    await user.click(screen.getByRole("button", { name: /open chat/i }));
    await waitFor(() => expect(api.startWhatsAppConversation).toHaveBeenCalledWith("k1"));
    await waitFor(() => expect(api.getWhatsAppThread).toHaveBeenCalledWith("c9"));
  });
});

describe("a conversation inside the 24 hour window", () => {
  async function open() {
    const user = userEvent.setup();
    render(<WhatsAppInbox socialAccountId={SA1} />);
    await user.click(await screen.findByRole("button", { name: /pablo/i }));
    await screen.findByText("Is my logo ready?");
    return user;
  }

  it("shows the window state, the messages with Meta's delivery state, and a free reply box", async () => {
    mockThread(OPEN, [msg(), msg({ id: "m2", direction: "outbound", text: "Yes, sending now.", status: "delivered" }), msg({ id: "m3", direction: "outbound", text: "Also this", status: "handed_off" }), msg({ id: "m4", direction: "outbound", text: "Broken", status: "failed", failureReason: "transient_error" })]);
    await open();
    expect(screen.getAllByText("Open, 5 hours left").length).toBeGreaterThan(0);
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("Handed to WhatsApp")).toBeInTheDocument();
    expect(screen.getByText("Not sent")).toBeInTheDocument();
    expect(screen.getByLabelText(/^message$/i)).toBeInTheDocument();
  });

  it("sends a reply, clears the box and reloads the thread", async () => {
    const user = await open();
    api.replyWhatsApp.mockResolvedValue({ messageId: "x", status: "handed_off", mode: "text", window: OPEN });
    await user.type(screen.getByLabelText(/^message$/i), "Your proof is ready.");
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(api.replyWhatsApp).toHaveBeenCalledWith("c1", "Your proof is ready."));
    await waitFor(() => expect(screen.getByLabelText(/^message$/i)).toHaveValue(""));
    expect(api.getWhatsAppThread.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not send an empty message", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    expect(api.replyWhatsApp).not.toHaveBeenCalled();
  });

  it("shows the server's words when a reply is refused", async () => {
    const user = await open();
    api.replyWhatsApp.mockRejectedValue(Object.assign(new Error("Sending is switched off right now."), { code: "sending_stopped" }));
    await user.type(screen.getByLabelText(/^message$/i), "hi");
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    expect(await screen.findByText(/sending is switched off right now/i)).toBeInTheDocument();
  });

  it("if Meta's window closed while typing, it says so and reloads so the template box appears", async () => {
    const user = await open();
    api.replyWhatsApp.mockRejectedValue(Object.assign(new Error("The 24 hour window is closed, so only an approved template can be sent. Pick a template instead."), { code: "window_closed" }));
    const before = api.getWhatsAppThread.mock.calls.length;
    await user.type(screen.getByLabelText(/^message$/i), "hi");
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    expect(await screen.findByText(/24 hour window is closed/i)).toBeInTheDocument();
    await waitFor(() => expect(api.getWhatsAppThread.mock.calls.length).toBeGreaterThan(before));
  });

  it("an approval request: title and message, three buttons, a plain 'not legal consent' note, and it is sent as buttons", async () => {
    const user = await open();
    api.sendWhatsAppApprovalRequest.mockResolvedValue({ messageId: "x", status: "handed_off", mode: "buttons", window: OPEN, approvalId: "a1" });
    await user.click(screen.getByRole("button", { name: /ask for approval/i }));
    expect(screen.getByText(/not legal consent/i)).toBeInTheDocument();
    expect(screen.getByText(/approve, request changes, question/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/what is being approved/i), "Logo proof v2");
    await user.type(screen.getByLabelText(/message to your client/i), "Please review the logo proof.");
    await user.click(screen.getByRole("button", { name: /send request/i }));
    await waitFor(() => expect(api.sendWhatsAppApprovalRequest).toHaveBeenCalledWith("c1", { title: "Logo proof v2", body: "Please review the logo proof." }));
  });

  it("an approval request needs both fields", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: /ask for approval/i }));
    await user.click(screen.getByRole("button", { name: /send request/i }));
    expect(api.sendWhatsAppApprovalRequest).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });

  it("shows an approval's state on the message that carried the buttons, with the client's answer", async () => {
    mockThread(OPEN, [
      msg({ id: "m2", direction: "outbound", kind: "interactive_buttons", text: "Please review.", status: "delivered", approval: { id: "a1", title: "Logo proof v2", options: [{ id: "approve", title: "Approve" }, { id: "changes", title: "Request changes" }], status: "approved", responseOptionId: "approve", responseTitle: "Approve", respondedAt: "2026-10-16T09:30:00.000Z", createdAt: "2026-10-16T09:00:00.000Z" } }),
    ]);
    await open().catch(() => undefined);
    expect(await screen.findByText(/logo proof v2/i)).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText(/they tapped: approve/i)).toBeInTheDocument();
  });
});

describe("a conversation outside the 24 hour window", () => {
  async function open(c: Partial<WhatsAppConversation> = {}) {
    mockThread(CLOSED, [msg()], c);
    api.listWhatsAppConversations.mockResolvedValue({ conversations: [conv({ window: CLOSED, ...c })], nextBefore: null });
    const user = userEvent.setup();
    render(<WhatsAppInbox socialAccountId={SA1} />);
    await user.click(await screen.findByRole("button", { name: /pablo/i }));
    await screen.findByText("Is my logo ready?");
    return user;
  }

  it("says closed, template required, and does NOT offer a free text box", async () => {
    await open();
    expect(screen.getAllByText("Closed, template required").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/^message$/i)).toBeNull();
    expect(screen.getByText(/24 hours after your contact last wrote/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^template$/i)).toBeInTheDocument();
  });

  it("sends an approved template with its values", async () => {
    const user = await open();
    api.sendWhatsAppTemplate.mockResolvedValue({ messageId: "x", status: "handed_off", mode: "template", window: CLOSED });
    await user.selectOptions(screen.getByLabelText(/^template$/i), "t1");
    expect(screen.getByText("Hi {{1}}, your project is {{2}}")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/value 1/i), "Pablo");
    await user.type(screen.getByLabelText(/value 2/i), "on track");
    await user.click(screen.getByRole("button", { name: /send template/i }));
    await waitFor(() => expect(api.sendWhatsAppTemplate).toHaveBeenCalledWith("c1", "t1", ["Pablo", "on track"]));
  });

  it("asks for every value before sending", async () => {
    const user = await open();
    await user.selectOptions(screen.getByLabelText(/^template$/i), "t1");
    await user.click(screen.getByRole("button", { name: /send template/i }));
    expect(api.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });

  it("a person who is not a saved contact cannot be sent a template: it says why instead", async () => {
    await open({ isContact: false });
    expect(screen.getByText(/messaged you first/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^template$/i)).toBeNull();
  });

  it("an approval request outside the window is sent as the chosen template, with a title", async () => {
    const user = await open();
    api.sendWhatsAppApprovalRequest.mockResolvedValue({ messageId: "x", status: "handed_off", mode: "template", window: CLOSED, approvalId: "a1" });
    await user.selectOptions(screen.getByLabelText(/^template$/i), "t1");
    await user.type(screen.getByLabelText(/value 1/i), "Pablo");
    await user.type(screen.getByLabelText(/value 2/i), "ready");
    await user.type(screen.getByLabelText(/track this as an approval request/i), "Logo proof v2");
    await user.click(screen.getByRole("button", { name: /send template/i }));
    await waitFor(() => expect(api.sendWhatsAppApprovalRequest).toHaveBeenCalledWith("c1", { title: "Logo proof v2", body: "Hi {{1}}, your project is {{2}}", templateId: "t1", params: ["Pablo", "ready"] }));
    expect(api.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });
});

describe("approvals", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    conversationId: "c1",
    messageId: "m1",
    title: "Logo proof v2",
    options: [{ id: "approve", title: "Approve" }],
    status: "pending",
    responseOptionId: null,
    responseTitle: null,
    respondedAt: null,
    createdAt: "2026-10-16T09:00:00.000Z",
    contactDisplay: "+27 ** *** 0001",
    displayName: "Pablo",
    ...over,
  });
  beforeEach(() => {
    api.listWhatsAppApprovals.mockResolvedValue({
      approvals: [item(), item({ id: "a2", title: "Site copy", status: "changes_requested", responseOptionId: "changes", responseTitle: "Request changes", respondedAt: "2026-10-16T10:00:00.000Z", displayName: null })],
      counts: { pending: 1, approved: 3, changes_requested: 1, question: 0, other_reply: 0 },
      note: "An approval is a convenience record of what your client tapped in WhatsApp. It is not legal consent, a signature or proof of a contract.",
    });
  });

  it("says plainly it is not legal consent, shows each request with its state and the client's answer, and the counts", async () => {
    const { container } = render(<WhatsAppApprovals />);
    expect(await screen.findByText(/not legal consent/i)).toBeInTheDocument();
    expect(screen.getByText("Logo proof v2")).toBeInTheDocument();
    expect(screen.getByText("Waiting for an answer", { selector: ".byok-chip" })).toBeInTheDocument();
    expect(screen.getByText("Changes requested", { selector: ".byok-chip" })).toBeInTheDocument();
    expect(screen.getByText(/they tapped: request changes/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^approved \(3\)/i })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(LONG_DIGIT_RUN);
  });

  it("filters by status", async () => {
    const user = userEvent.setup();
    render(<WhatsAppApprovals />);
    await screen.findByText("Logo proof v2");
    await user.click(screen.getByRole("button", { name: /^waiting \(1\)/i }));
    await waitFor(() => expect(api.listWhatsAppApprovals).toHaveBeenLastCalledWith("pending"));
  });

  it("says so when there are none", async () => {
    api.listWhatsAppApprovals.mockResolvedValue({ approvals: [], counts: { pending: 0, approved: 0, changes_requested: 0, question: 0, other_reply: 0 }, note: "" });
    render(<WhatsAppApprovals />);
    expect(await screen.findByText(/no approval requests yet/i)).toBeInTheDocument();
  });
});

describe("saved audiences and update lines", () => {
  const audience = (over = {}) => ({ id: "au1", socialAccountId: SA1, name: "Website clients", memberCount: 2, ...over });
  beforeEach(() => {
    api.listWhatsAppAudiences.mockResolvedValue({ audiences: [audience()] });
  });

  it("lists audiences with their size, and creates one", async () => {
    const user = userEvent.setup();
    api.createWhatsAppAudience.mockResolvedValue({ id: "au2" });
    render(<WhatsAppAudiences socialAccountId={SA1} />);
    expect(await screen.findByText("Website clients")).toBeInTheDocument();
    expect(screen.getByText(/2 people/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/new audience name/i), "Retainer clients");
    await user.click(screen.getByRole("button", { name: /create audience/i }));
    await waitFor(() => expect(api.createWhatsAppAudience).toHaveBeenCalledWith(SA1, "Retainer clients"));
  });

  it("adds saved, opted-in contacts to an audience by tick box", async () => {
    const user = userEvent.setup();
    api.addWhatsAppAudienceMembers.mockResolvedValue({ added: 1, skipped: 0 });
    render(<WhatsAppAudiences socialAccountId={SA1} />);
    await user.click(await screen.findByRole("button", { name: /add people to website clients/i }));
    await user.click(await screen.findByRole("checkbox", { name: /thandi/i }));
    await user.click(screen.getByRole("button", { name: /add selected/i }));
    await waitFor(() => expect(api.addWhatsAppAudienceMembers).toHaveBeenCalledWith("au1", ["k1"]));
    expect(api.listWhatsAppContacts).toHaveBeenCalledWith(expect.objectContaining({ status: "opted_in", socialAccountId: SA1 }));
  });

  it("sends a short update: free text where the window is open, the chosen template where it is closed, and shows who got it", async () => {
    const user = userEvent.setup();
    api.sendWhatsAppAudienceUpdate.mockResolvedValue({
      summary: { total: 3, sent: 2, skipped: 1, failed: 0, notAttempted: 0 },
      results: [
        { contactDisplay: "+27 ** *** 0001", status: "sent", how: "text" },
        { contactDisplay: "+27 ** *** 0002", status: "sent", how: "template" },
        { contactDisplay: "+27 ** *** 0003", status: "skipped", code: "window_closed" },
      ],
    });
    const { container } = render(<WhatsAppAudiences socialAccountId={SA1} />);
    await user.click(await screen.findByRole("button", { name: /send an update to website clients/i }));
    await user.type(screen.getByLabelText(/^update$/i), "Your site goes live on Friday.");
    await user.selectOptions(screen.getByLabelText(/template for people outside the 24 hour window/i), "t1");
    await user.type(screen.getByLabelText(/value 1/i), "Friend");
    await user.type(screen.getByLabelText(/value 2/i), "live soon");
    await user.click(screen.getByRole("button", { name: /^send update/i }));
    await waitFor(() => expect(api.sendWhatsAppAudienceUpdate).toHaveBeenCalledWith("au1", { text: "Your site goes live on Friday.", templateId: "t1", params: ["Friend", "live soon"] }));
    expect(await screen.findByText(/sent to 2 of 3/i)).toBeInTheDocument();
    expect(screen.getByText(/window closed and no template chosen/i)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(LONG_DIGIT_RUN);
  });

  it("an update needs some text, and says what it will do first", async () => {
    const user = userEvent.setup();
    render(<WhatsAppAudiences socialAccountId={SA1} />);
    await user.click(await screen.findByRole("button", { name: /send an update to website clients/i }));
    expect(screen.getByText(/typed freely to people whose 24 hour window is open/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^send update/i }));
    expect(api.sendWhatsAppAudienceUpdate).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });

  it("deletes an audience after one confirmation", async () => {
    const user = userEvent.setup();
    api.deleteWhatsAppAudience.mockResolvedValue({ ok: true });
    render(<WhatsAppAudiences socialAccountId={SA1} />);
    await user.click(await screen.findByRole("button", { name: /delete website clients/i }));
    expect(api.deleteWhatsAppAudience).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /yes, delete it/i }));
    await waitFor(() => expect(api.deleteWhatsAppAudience).toHaveBeenCalledWith("au1"));
  });
});

describe("Start a conversation (type a number, click Start chat)", () => {
  const SENTENCE = "By initializing this chat, you confirm compliance with Meta's user opt-in messaging policies.";

  it("shows one labelled input, a Start chat button and the single reminder sentence under it, and no consent form fields", async () => {
    const { container } = render(<WhatsAppInbox socialAccountId={SA1} />);
    await screen.findByText("Pablo");
    const input = screen.getByLabelText("Start a conversation");
    expect(input).toHaveAttribute("type", "tel");
    expect(screen.getByRole("button", { name: "Start chat" })).toBeInTheDocument();
    const reminder = screen.getByText(SENTENCE);
    expect(input.compareDocumentPosition(reminder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).not.toMatch(/date they gave consent|where did the consent come from|proof reference|what did they agree to/i);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("keeps Start chat off until a number is typed, and the number out of session replay", async () => {
    render(<WhatsAppInbox socialAccountId={SA1} />);
    await screen.findByText("Pablo");
    expect(screen.getByRole("button", { name: "Start chat" })).toBeDisabled();
    await userEvent.setup().type(screen.getByLabelText("Start a conversation"), "+27 82 123 4567");
    expect(screen.getByRole("button", { name: "Start chat" })).toBeEnabled();
    expect(screen.getByLabelText("Start a conversation").closest(".ph-no-capture")).not.toBeNull();
  });

  it("sends only the connection and the number, then opens the new chat and refreshes the list", async () => {
    const user = userEvent.setup();
    api.startWhatsAppDirectChat.mockResolvedValue({ conversationId: "c9", created: true, contactCreated: true, window: CLOSED });
    mockThread(CLOSED, [], { id: "c9" });
    render(<WhatsAppInbox socialAccountId={SA1} />);
    await screen.findByText("Pablo");
    const listCalls = api.listWhatsAppConversations.mock.calls.length;
    await user.type(screen.getByLabelText("Start a conversation"), "+27 82 123 4567");
    await user.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(api.startWhatsAppDirectChat).toHaveBeenCalledTimes(1));
    expect(api.startWhatsAppDirectChat).toHaveBeenCalledWith(SA1, "+27 82 123 4567");
    await waitFor(() => expect(api.getWhatsAppThread).toHaveBeenCalledWith("c9"));
    expect(api.listWhatsAppConversations.mock.calls.length).toBeGreaterThan(listCalls);
    expect(screen.getByLabelText("Start a conversation")).toHaveValue("");
  });

  it("Enter in the box starts the chat too", async () => {
    const user = userEvent.setup();
    api.startWhatsAppDirectChat.mockResolvedValue({ conversationId: "c9", created: true, contactCreated: true, window: CLOSED });
    mockThread(CLOSED, [], { id: "c9" });
    render(<WhatsAppInbox socialAccountId={SA1} />);
    await screen.findByText("Pablo");
    await user.type(screen.getByLabelText("Start a conversation"), "+27821234567{Enter}");
    await waitFor(() => expect(api.startWhatsAppDirectChat).toHaveBeenCalledWith(SA1, "+27821234567"));
  });

  it("shows the server's refusal in words and keeps the typed number so it can be fixed", async () => {
    const user = userEvent.setup();
    api.startWhatsAppDirectChat.mockRejectedValue(new Error("This number has opted out and cannot be messaged."));
    render(<WhatsAppInbox socialAccountId={SA1} />);
    await screen.findByText("Pablo");
    await user.type(screen.getByLabelText("Start a conversation"), "+27 82 123 4567");
    await user.click(screen.getByRole("button", { name: "Start chat" }));
    expect(await screen.findByText(/has opted out and cannot be messaged/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Start a conversation")).toHaveValue("+27 82 123 4567");
  });

  it("the saved contacts picker still works, under its own button", async () => {
    const user = userEvent.setup();
    api.startWhatsAppConversation.mockResolvedValue({ conversationId: "c8", created: true, window: CLOSED });
    mockThread(CLOSED, [], { id: "c8" });
    render(<WhatsAppInbox socialAccountId={SA1} />);
    await screen.findByText("Pablo");
    await user.selectOptions(screen.getByLabelText("Or pick a saved contact"), "k1");
    await user.click(screen.getByRole("button", { name: "Open chat" }));
    await waitFor(() => expect(api.startWhatsAppConversation).toHaveBeenCalledWith("k1"));
  });
});

describe("wording rules", () => {
  it("no em dash or en dash in the sources", () => {
    for (const f of ["WhatsAppInbox.tsx", "WhatsAppThread.tsx", "WhatsAppApprovals.tsx", "WhatsAppAudiences.tsx"]) {
      const src = readFileSync(resolve(__dirname, f), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      expect(src, f).not.toMatch(/[–—]/);
    }
  });
  it("renders nothing from within() that looks like a phone number", async () => {
    const { container } = render(<WhatsAppInbox socialAccountId={SA1} />);
    await screen.findByText("Pablo");
    expect(within(container).queryByText(LONG_DIGIT_RUN)).toBeNull();
  });
});

describe("no limit on audience size", () => {
  it("shows the result of an update line to 100 people in full", async () => {
    const user = userEvent.setup();
    api.listWhatsAppAudiences.mockResolvedValue({ audiences: [{ id: "au1", socialAccountId: SA1, name: "Everyone", memberCount: 100 }] });
    api.sendWhatsAppAudienceUpdate.mockResolvedValue({
      summary: { total: 100, sent: 100, skipped: 0, failed: 0, notAttempted: 0 },
      results: Array.from({ length: 100 }, (_, i) => ({ contactDisplay: `+27 ** *** ${String(1000 + i).slice(-4)}`, status: "sent" as const, how: "text" as const })),
    });
    render(<WhatsAppAudiences socialAccountId={SA1} />);
    expect(await screen.findByText("100 people")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /send an update to everyone/i }));
    await user.type(screen.getByLabelText(/^update$/i), "Site goes live Friday.");
    await user.click(screen.getByRole("button", { name: /^send update/i }));
    expect(await screen.findByText(/sent to 100 of 100/i)).toBeInTheDocument();
    expect(screen.queryByText(/at most|up to 25|too large/i)).toBeNull();
  });
});
