import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The WhatsApp message history viewer. The API is a mock: nothing real is called, and no real phone number exists anywhere.

const api = vi.hoisted(() => ({
  checkXKeys: vi.fn(),
  connectXKeys: vi.fn(),
  checkWhatsAppCredentials: vi.fn(),
  connectWhatsAppCredentials: vi.fn(),
  getWhatsAppWebhookInfo: vi.fn(),
  getWhatsAppMessages: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

import { CustomPlatformSettings } from "./CustomPlatformSettings";
import { WhatsAppThreadViewer } from "./WhatsAppThreadViewer";
import { groupThreads, safeDisplay, safeName, threadLabel, triageBadges } from "../../lib/whatsappThreads";
import type { PlatformInfo, SocialAccount, WhatsAppMessage, WhatsAppWebhookInfo } from "../../lib/api";

const SA1 = "11111111-1111-4111-8111-111111111111";
const SA2 = "22222222-2222-4222-8222-222222222222";
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const acct = (id: string, name: string | null, platform = "whatsapp"): SocialAccount => ({
  id,
  platform,
  platform_account_id: "109876543210987",
  display_name: name,
  connected_at: "2026-10-01T00:00:00Z",
  brand_label: null,
  brand_id: null,
});
const ACCOUNTS = [acct(SA1, "Acme Cafe"), acct(SA2, "Acme Bakery"), acct("33333333-3333-4333-8333-333333333333", "Not whatsapp", "x")];

let n = 0;
const msg = (over: Partial<WhatsAppMessage> = {}): WhatsAppMessage => {
  n++;
  return {
    id: `m${n}`,
    wamid: String(n).padStart(64, "0"),
    contactKey: KEY_A,
    contactDisplay: "+27 ** *** 1111",
    contactName: "Thandi",
    text: `message ${n}`,
    receivedAt: new Date(Date.UTC(2026, 9, 10, 10, n)).toISOString(),
    triageCategory: null,
    needsAttention: null,
    triageReason: null,
    triagedAt: null,
    ...over,
  };
};
const page = (messages: WhatsAppMessage[], nextBefore: string | null = null) => ({ messages, nextBefore });

afterEach(cleanup);
beforeEach(() => {
  n = 0;
  for (const fn of Object.values(api)) fn.mockReset();
});

const firstThread = async () => within(await screen.findByRole("listbox")).getAllByRole("option")[0];
const renderViewer = (props: Partial<React.ComponentProps<typeof WhatsAppThreadViewer>> = {}) => render(<WhatsAppThreadViewer accounts={ACCOUNTS} triageEnabled={false} {...props} />);

describe("conversation list", () => {
  it("lists only WhatsApp connections in the picker and loads the first one", async () => {
    api.getWhatsAppMessages.mockResolvedValue(page([msg()]));
    renderViewer();
    const select = screen.getByLabelText("WhatsApp number") as HTMLSelectElement;
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Acme Cafe", "Acme Bakery"]);
    await screen.findByRole("listbox");
    expect(api.getWhatsAppMessages).toHaveBeenCalledWith(expect.objectContaining({ socialAccountId: SA1, limit: 100 }));
  });

  it("groups messages by contact, labels with the name plus the mask, and sorts by the latest message", async () => {
    const old = msg({ contactKey: KEY_B, contactName: "Pieter", contactDisplay: "+27 ** *** 2222" });
    const a1 = msg();
    const a2 = msg();
    api.getWhatsAppMessages.mockResolvedValue(page([a2, a1, old])); // newest first, as the route answers
    renderViewer();
    const options = within(await screen.findByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("Thandi (+27 ** *** 1111)");
    expect(options[0]).toHaveTextContent("2 messages");
    expect(options[1]).toHaveTextContent("Pieter (+27 ** *** 2222)");
    expect(options[1]).toHaveTextContent("1 message");
  });

  it("never shows a raw number: a long digit run in a mask or a name is replaced", async () => {
    const m = msg({ contactDisplay: "27820001111", contactName: "+27 82 000 1111" });
    api.getWhatsAppMessages.mockResolvedValue(page([m]));
    const { container } = renderViewer();
    await screen.findByRole("listbox");
    expect(container.textContent).not.toMatch(/\d{7,}/);
    expect(container.textContent).not.toContain("27820001111");
    expect(container.textContent).not.toContain("82 000 1111");
    expect(within(screen.getByRole("listbox")).getByRole("option")).toHaveTextContent("Unknown contact");
  });

  it("has loading, empty and error states", async () => {
    let resolve!: (v: ReturnType<typeof page>) => void;
    api.getWhatsAppMessages.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { unmount } = renderViewer();
    expect(screen.getByText("Loading messages...")).toBeInTheDocument();
    resolve(page([]));
    expect(await screen.findByText(/No messages yet/)).toBeInTheDocument();
    unmount();
    api.getWhatsAppMessages.mockRejectedValueOnce(new Error("Something broke"));
    renderViewer();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something broke");
  });

  it("with no WhatsApp connection it says so and requests nothing", () => {
    renderViewer({ accounts: [acct("x1", "An X account", "x")] });
    expect(screen.getByText(/Connect a WhatsApp number above/)).toBeInTheDocument();
    expect(api.getWhatsAppMessages).not.toHaveBeenCalled();
  });

  it("switching the number loads that number's messages", async () => {
    api.getWhatsAppMessages.mockResolvedValue(page([msg()]));
    const user = userEvent.setup();
    renderViewer();
    await screen.findByRole("listbox");
    await user.selectOptions(screen.getByLabelText("WhatsApp number"), SA2);
    await waitFor(() => expect(api.getWhatsAppMessages).toHaveBeenLastCalledWith(expect.objectContaining({ socialAccountId: SA2 })));
  });

  it("Load older messages pages with nextBefore and merges without duplicates", async () => {
    const first = [msg({ contactKey: KEY_A }), msg({ contactKey: KEY_A })];
    const older = msg({ contactKey: KEY_B, contactName: "Pieter", contactDisplay: "+27 ** *** 2222" });
    api.getWhatsAppMessages.mockResolvedValueOnce(page(first, "2026-10-10T10:01:00.000Z")).mockResolvedValueOnce(page([first[0], older], null));
    const user = userEvent.setup();
    renderViewer();
    await screen.findByRole("listbox");
    await user.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(2));
    expect(api.getWhatsAppMessages).toHaveBeenLastCalledWith(expect.objectContaining({ socialAccountId: SA1, before: "2026-10-10T10:01:00.000Z" }));
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: /Thandi/ })).toHaveTextContent("2 messages"); // the repeated message counted once
    expect(screen.queryByRole("button", { name: "Load older messages" })).not.toBeInTheDocument();
  });
});

describe("keyboard", () => {
  it("is a listbox: arrow keys move the active conversation, Enter opens it", async () => {
    const a = msg({ contactKey: KEY_A });
    const b = msg({ contactKey: KEY_B, contactName: "Pieter", contactDisplay: "+27 ** *** 2222" });
    api.getWhatsAppMessages.mockResolvedValueOnce(page([b, a])).mockResolvedValueOnce(page([a]));
    const user = userEvent.setup();
    renderViewer();
    const box = await screen.findByRole("listbox");
    expect(box).toHaveAccessibleName(/Conversations, newest first/);
    const [first, second] = within(box).getAllByRole("option");
    box.focus();
    expect(box).toHaveAttribute("aria-activedescendant", first.id);
    await user.keyboard("{ArrowDown}");
    expect(box).toHaveAttribute("aria-activedescendant", second.id);
    expect(second).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{End}{Home}");
    expect(first).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: "Back to conversations" });
    expect(api.getWhatsAppMessages).toHaveBeenLastCalledWith(expect.objectContaining({ contactKey: KEY_B, limit: 50 }));
  });
});

describe("one conversation", () => {
  it("shows its messages oldest to newest and badges when triage fields exist", async () => {
    const m1 = msg({ text: "first one" });
    const m2 = msg({ text: "second one", needsAttention: true, triageCategory: "angry_customer" });
    const m3 = msg({ text: "third one", triageCategory: "routine", needsAttention: false });
    api.getWhatsAppMessages.mockResolvedValueOnce(page([m3, m2, m1])).mockResolvedValueOnce(page([m3, m2, m1])); // newest first
    const user = userEvent.setup();
    renderViewer();
    await user.click(await firstThread());
    const list = await screen.findByRole("list", { name: "Messages, oldest first" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".byok-msg__text")?.textContent)).toEqual(["first one", "second one", "third one"]);
    expect(items[0].querySelector(".byok-chip")).toBeNull(); // no triage fields: no badge
    expect(items[1]).toHaveTextContent("Needs attention");
    expect(items[1]).toHaveTextContent("Upset customer");
    expect(items[2]).toHaveTextContent("Routine");
    expect(items[2]).not.toHaveTextContent("Needs attention");
    expect(screen.getByRole("heading", { name: "Thandi (+27 ** *** 1111)" })).toBeInTheDocument();
  });

  it("Load older adds earlier messages above, and Back returns to the conversations", async () => {
    const early = msg({ text: "earlier" });
    const late = msg({ text: "later" });
    api.getWhatsAppMessages
      .mockResolvedValueOnce(page([late, early])) // the list
      .mockResolvedValueOnce(page([late], late.receivedAt)) // the conversation, first page
      .mockResolvedValueOnce(page([early], null)); // older
    const user = userEvent.setup();
    renderViewer();
    await user.click(await firstThread());
    await screen.findByText("later");
    await user.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(screen.getByText("earlier")).toBeInTheDocument());
    expect(api.getWhatsAppMessages).toHaveBeenLastCalledWith(expect.objectContaining({ contactKey: KEY_A, before: late.receivedAt }));
    const texts = within(screen.getByRole("list", { name: "Messages, oldest first" })).getAllByRole("listitem").map((li) => li.querySelector(".byok-msg__text")?.textContent);
    expect(texts).toEqual(["earlier", "later"]);
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to conversations" }));
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });

  it("shows an error for a conversation that fails to load", async () => {
    api.getWhatsAppMessages.mockResolvedValueOnce(page([msg()])).mockRejectedValueOnce(new Error("Could not reach the server"));
    const user = userEvent.setup();
    renderViewer();
    await user.click(await firstThread());
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
  });

  it("shows message text as plain text, never as markup", async () => {
    const m = msg({ text: "<img src=x onerror=alert(1)> hello" });
    api.getWhatsAppMessages.mockResolvedValueOnce(page([m])).mockResolvedValueOnce(page([m]));
    const user = userEvent.setup();
    const { container } = renderViewer();
    await user.click(await firstThread());
    await screen.findByRole("list", { name: "Messages, oldest first" });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)> hello");
  });
});

describe("notes", () => {
  it("always says messages are deleted after 30 days; the AI sentence follows the server's boolean", async () => {
    api.getWhatsAppMessages.mockResolvedValue(page([]));
    const { rerender } = renderViewer({ triageEnabled: false });
    expect(screen.getByText("Messages are deleted after 30 days. AI sorting is off.")).toBeInTheDocument();
    rerender(<WhatsAppThreadViewer accounts={ACCOUNTS} triageEnabled={true} />);
    expect(screen.getByText("Messages are deleted after 30 days.")).toBeInTheDocument();
    rerender(<WhatsAppThreadViewer accounts={ACCOUNTS} triageEnabled={null} />);
    expect(screen.queryByText(/AI sorting/)).not.toBeInTheDocument();
    await screen.findByText(/No messages yet/);
  });

  it("has no sending controls", async () => {
    api.getWhatsAppMessages.mockResolvedValue(page([msg()]));
    renderViewer();
    await screen.findByRole("listbox");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send|reply/i })).not.toBeInTheDocument();
  });

  it("flags a number whose inbound is off, from the server's boolean", async () => {
    api.getWhatsAppMessages.mockResolvedValue(page([]));
    renderViewer({ inboundReady: { [SA1]: false } });
    expect(screen.getByText("Inbound off: App Secret not saved")).toBeInTheDocument();
    await screen.findByText(/No messages yet/);
  });
});

describe("inside the Custom Developer Keys panel", () => {
  const WA_OK: PlatformInfo = { platform: "whatsapp", configured: true, comingSoon: false, requiresPlan: "Business", allowed: true };
  const INFO: WhatsAppWebhookInfo = {
    webhookUrl: "https://api.example.test/api/webhooks/whatsapp",
    verifyToken: "handshake-token-not-real",
    verifyTokenConfigured: true,
    connections: [{ socialAccountId: SA1, displayName: "Acme Cafe", inboundReady: true }],
    triageEnabled: false,
  };

  it("shows the viewer for an unlocked plan, with the AI sentence from the webhook-info boolean", async () => {
    api.getWhatsAppWebhookInfo.mockResolvedValue(INFO);
    api.getWhatsAppMessages.mockResolvedValue(page([msg()]));
    render(<CustomPlatformSettings platforms={[WA_OK]} accounts={ACCOUNTS} />);
    expect(await screen.findByText("Messages are deleted after 30 days. AI sorting is off.")).toBeInTheDocument();
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });

  it("a locked plan shows no viewer and requests no messages", () => {
    render(<CustomPlatformSettings platforms={[{ ...WA_OK, allowed: false }]} accounts={ACCOUNTS} />);
    expect(screen.queryByText("WhatsApp messages")).not.toBeInTheDocument();
    expect(api.getWhatsAppMessages).not.toHaveBeenCalled();
    expect(api.getWhatsAppWebhookInfo).not.toHaveBeenCalled();
  });
});

describe("thread helpers", () => {
  it("groups, sorts conversations by their latest message and messages oldest to newest", () => {
    const a1 = msg({ contactKey: KEY_A });
    const b1 = msg({ contactKey: KEY_B, contactName: null, contactDisplay: "+27 ** *** 2222" });
    const a2 = msg({ contactKey: KEY_A });
    const threads = groupThreads([a2, b1, a1, a1]);
    expect(threads.map((t) => t.contactKey)).toEqual([KEY_A, KEY_B]);
    expect(threads[0].messages.map((m) => m.id)).toEqual([a1.id, a2.id]);
    expect(threads[0].count).toBe(2);
    expect(threads[1].label).toBe("+27 ** *** 2222");
  });

  it("labels, masks and badges", () => {
    expect(threadLabel({ contactName: "Thandi", contactDisplay: "+27 ** *** 1111" })).toBe("Thandi (+27 ** *** 1111)");
    expect(safeDisplay(null)).toBe("Unknown contact");
    expect(safeDisplay("+27 82 000 1111")).toBe("Unknown contact");
    expect(safeName("0820001111")).toBeNull();
    expect(triageBadges({ needsAttention: true, triageCategory: "sales_question" }).map((b) => b.text)).toEqual(["Needs attention", "Sales question"]);
    expect(triageBadges({ needsAttention: null, triageCategory: null })).toEqual([]);
    expect(triageBadges({ needsAttention: false, triageCategory: "new_kind" }).map((b) => b.text)).toEqual(["new kind"]);
  });
});
