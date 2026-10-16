import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";

// The WhatsApp dashboard tab: shown only when the server says broadcasts are on (GET /whatsapp/capabilities), and what it
// renders. The API is a mock.

const api = vi.hoisted(() => ({
  getWhatsAppCapabilities: vi.fn(),
  listWhatsAppContacts: vi.fn(),
  listWhatsAppOptOuts: vi.fn(),
  addWhatsAppContact: vi.fn(),
  importWhatsAppContacts: vi.fn(),
  optOutWhatsAppContact: vi.fn(),
  eraseWhatsAppContact: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

const state = vi.hoisted(() => ({ accounts: [] as Array<{ id: string; platform: string; display_name: string | null }> }));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ({ accounts: state.accounts }) }));

import { WhatsAppTab } from "./WhatsAppTab";
import { useWhatsAppBroadcasts } from "./useWhatsAppBroadcasts";
import { moreTabsFor } from "./dashboardHelpers";

const SA1 = "11111111-1111-4111-8111-111111111111";
const SA2 = "22222222-2222-4222-8222-222222222222";

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listWhatsAppContacts.mockResolvedValue({ contacts: [], nextBefore: null });
  api.listWhatsAppOptOuts.mockResolvedValue({ count: 0, optOuts: [] });
  state.accounts = [];
});

describe("moreTabsFor", () => {
  it("adds the WhatsApp tab only when broadcasts are on", () => {
    expect(moreTabsFor(false)).not.toContain("WhatsApp");
    expect(moreTabsFor(true)).toContain("WhatsApp");
    expect(moreTabsFor(false)).toEqual(["Analytics", "Mentions", "DMs", "Bio Page"]);
  });
});

describe("useWhatsAppBroadcasts", () => {
  it("is true only when the server says so", async () => {
    api.getWhatsAppCapabilities.mockResolvedValue({ broadcasts: true });
    const { result } = renderHook(() => useWhatsAppBroadcasts(true));
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("stays false when the server says false or fails, and does not ask without a WhatsApp connection", async () => {
    api.getWhatsAppCapabilities.mockResolvedValue({ broadcasts: false });
    const off = renderHook(() => useWhatsAppBroadcasts(true));
    await waitFor(() => expect(api.getWhatsAppCapabilities).toHaveBeenCalledTimes(1));
    expect(off.result.current).toBe(false);

    api.getWhatsAppCapabilities.mockReset();
    api.getWhatsAppCapabilities.mockRejectedValue(new Error("boom"));
    const failing = renderHook(() => useWhatsAppBroadcasts(true));
    await waitFor(() => expect(api.getWhatsAppCapabilities).toHaveBeenCalledTimes(1));
    expect(failing.result.current).toBe(false);

    api.getWhatsAppCapabilities.mockReset();
    renderHook(() => useWhatsAppBroadcasts(false));
    expect(api.getWhatsAppCapabilities).not.toHaveBeenCalled();
  });
});

describe("WhatsAppTab", () => {
  it("asks to connect a number first when there is none", () => {
    state.accounts = [{ id: "x", platform: "x", display_name: "X" }];
    render(<WhatsAppTab />);
    expect(screen.getByText(/connect a whatsapp number first/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add contact/i })).toBeNull();
  });

  it("says plainly that nothing is sent, and shows the CSV import, contacts and opt-outs for the connection, with no one-by-one consent form", async () => {
    state.accounts = [{ id: SA1, platform: "whatsapp", display_name: "Acme Cafe" }];
    render(<WhatsAppTab />);
    expect(screen.getByText(/nothing is sent/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add contact/i })).toBeNull();
    expect(screen.queryByLabelText(/date they gave consent|where did the consent come from|proof reference|what did they agree to/i)).toBeNull();
    expect(screen.getByLabelText(/csv file/i)).toBeInTheDocument();
    await waitFor(() => expect(api.listWhatsAppContacts).toHaveBeenCalledWith(expect.objectContaining({ socialAccountId: SA1 })));
    await waitFor(() => expect(api.listWhatsAppOptOuts).toHaveBeenCalled());
  });

  it("lets the customer pick between several WhatsApp numbers", async () => {
    state.accounts = [
      { id: SA1, platform: "whatsapp", display_name: "Acme Cafe" },
      { id: SA2, platform: "whatsapp", display_name: "Acme Bakery" },
    ];
    render(<WhatsAppTab />);
    const picker = screen.getByLabelText(/whatsapp number/i);
    expect(picker).toHaveValue(SA1);
    expect(screen.getByRole("option", { name: "Acme Bakery" })).toBeInTheDocument();
  });
});
