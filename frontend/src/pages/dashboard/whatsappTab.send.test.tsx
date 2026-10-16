import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The WhatsApp tab with sending: the Inbox, Approvals, Broadcasts, Updates and Contacts views appear only when the server says sending is
// on for this account (GET /whatsapp/send-capabilities). With it off the tab is the contacts and consent screen of Phase 1, unchanged.
// The setup guide is always there, collapsed. The API is a mock.

const api = vi.hoisted(() => ({
  getWhatsAppSendCapabilities: vi.fn(),
  listWhatsAppConversations: vi.fn(),
  listWhatsAppContacts: vi.fn(),
  listWhatsAppOptOuts: vi.fn(),
  listWhatsAppTemplates: vi.fn(),
  getWhatsAppRateCard: vi.fn(),
  listWhatsAppBroadcasts: vi.fn(),
  listWhatsAppApprovals: vi.fn(),
  listWhatsAppAudiences: vi.fn(),
  getWhatsAppThread: vi.fn(),
  markWhatsAppConversationRead: vi.fn(),
  addWhatsAppContact: vi.fn(),
  importWhatsAppContacts: vi.fn(),
  optOutWhatsAppContact: vi.fn(),
  eraseWhatsAppContact: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

const state = vi.hoisted(() => ({ accounts: [] as Array<{ id: string; platform: string; display_name: string | null }> }));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ({ accounts: state.accounts }) }));

import { WhatsAppTab } from "./WhatsAppTab";
import { WHATSAPP_GUIDE } from "../../lib/byokGuides";

const SA1 = "11111111-1111-4111-8111-111111111111";

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  state.accounts = [{ id: SA1, platform: "whatsapp", display_name: "Acme Cafe" }];
  api.getWhatsAppSendCapabilities.mockResolvedValue({ sending: true, stopped: false });
  api.listWhatsAppConversations.mockResolvedValue({ conversations: [], nextBefore: null });
  api.listWhatsAppContacts.mockResolvedValue({ contacts: [], nextBefore: null });
  api.listWhatsAppOptOuts.mockResolvedValue({ count: 0, optOuts: [] });
  api.listWhatsAppTemplates.mockResolvedValue({ templates: [] });
  api.getWhatsAppRateCard.mockResolvedValue({ rateCard: null });
  api.listWhatsAppBroadcasts.mockResolvedValue({ broadcasts: [], nextBefore: null });
  api.listWhatsAppApprovals.mockResolvedValue({ approvals: [], counts: { pending: 0, approved: 0, changes_requested: 0, question: 0, other_reply: 0 }, note: "" });
  api.listWhatsAppAudiences.mockResolvedValue({ audiences: [] });
});

describe("WhatsApp tab, sending on", () => {
  it("opens on the Inbox and offers the five views", async () => {
    render(<WhatsAppTab />);
    expect(await screen.findByText("Conversations")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: /whatsapp views/i });
    for (const label of ["Inbox", "Approvals", "Broadcasts", "Updates", "Contacts"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText(/meta bills your own whatsapp business account directly/i)).toBeInTheDocument();
  });

  it("each view shows its own screen", async () => {
    const user = userEvent.setup();
    render(<WhatsAppTab />);
    await screen.findByText("Conversations");
    await user.click(screen.getByRole("button", { name: "Approvals" }));
    expect(await screen.findByText("Approval requests")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Broadcasts" }));
    expect(await screen.findByText("Message templates")).toBeInTheDocument();
    expect(screen.getByText("New broadcast")).toBeInTheDocument();
    expect(screen.getByText("Your broadcasts")).toBeInTheDocument();
    expect(screen.getByText("Your WhatsApp prices")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Updates" }));
    expect(await screen.findByText("Audiences and updates")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Contacts" }));
    expect(await screen.findByRole("button", { name: /add contact/i })).toBeInTheDocument();
    expect(screen.getByText("Opted-out numbers")).toBeInTheDocument();
  });

  it("always shows the collapsed setup guide with every step", async () => {
    const { container } = render(<WhatsAppTab />);
    await screen.findByText("Conversations");
    const details = container.querySelector("details.byok-guide") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText(WHATSAPP_GUIDE.title)).toBeInTheDocument();
    for (const step of WHATSAPP_GUIDE.steps) expect(screen.getByText(step.title)).toBeInTheDocument();
  });

  it("still asks to connect a number first, and still shows the guide, when there is none", async () => {
    state.accounts = [];
    render(<WhatsAppTab />);
    expect(screen.getByText(/connect a whatsapp number first/i)).toBeInTheDocument();
    expect(screen.getByText(WHATSAPP_GUIDE.title)).toBeInTheDocument();
  });
});

describe("WhatsApp tab, sending off", () => {
  it("is the contacts and consent screen of Phase 1: no views, nothing is sent, and it says so", async () => {
    api.getWhatsAppSendCapabilities.mockResolvedValue({ sending: false, stopped: false });
    render(<WhatsAppTab />);
    expect(await screen.findByRole("button", { name: /add contact/i })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: /whatsapp views/i })).toBeNull();
    expect(screen.getByText(/nothing is sent from here yet/i)).toBeInTheDocument();
    expect(api.listWhatsAppConversations).not.toHaveBeenCalled();
  });

  it("says when sending is switched off for now, and keeps the contacts working", async () => {
    api.getWhatsAppSendCapabilities.mockResolvedValue({ sending: false, stopped: true });
    render(<WhatsAppTab />);
    expect(await screen.findByText(/sending is switched off right now/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add contact/i })).toBeInTheDocument();
  });

  it("treats a failing capability check as off", async () => {
    api.getWhatsAppSendCapabilities.mockRejectedValue(new Error("boom"));
    render(<WhatsAppTab />);
    await waitFor(() => expect(api.getWhatsAppSendCapabilities).toHaveBeenCalled());
    expect(screen.queryByRole("navigation", { name: /whatsapp views/i })).toBeNull();
  });
});
