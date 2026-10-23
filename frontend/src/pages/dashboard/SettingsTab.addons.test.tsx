import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The legacy storage and seat add-ons in Settings can only be cancelled: a customer who already has one sees it with a Cancel
// button, and there is no button anywhere in these views to buy another.

const dash = vi.hoisted(() => ({ extra: {} as Record<string, unknown> }));
vi.mock("../../lib/supabase", () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } } }));
vi.mock("./DashboardContext", () => ({
  useDashboard: () =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, key: string) {
        if (key in dash.extra) return dash.extra[key];
        if (key === "session") return { user: { id: "u1", email: "owner@example.com" } };
        if (key === "account") return { id: "acc1", business_name: "Acme", voice_profile: null, show_branding_tag: true, failure_alerts: true };
        if (["mediaFiles", "storageAddons", "team", "accounts", "platforms"].includes(key)) return [];
        if (key === "mediaAltTextDrafts") return {};
        if (key === "billingSectionRef") return { current: null };
        if (key === "billingBusy" || key === "deferredLoading") return key === "billingBusy" ? null : false;
        if (/^(handle|set|setShow|refresh)/.test(key)) return vi.fn();
        return undefined;
      },
    }),
}));

const cancelStorage = vi.fn();
const cancelSeat = vi.fn();
const storageAddon = { id: "st1", gb_amount: 20, status: "active", cancel_at_period_end: false, current_period_end: null };
const seatAddon = { id: "se1", status: "active", cancel_at_period_end: false, current_period_end: null };

const BUY = /buy|purchase|add (more )?(storage|seat)|another (seat|storage)|upgrade storage|\$\d/i;

async function open(tab: "Plan & billing" | "Team") {
  vi.resetModules();
  const { SettingsTab } = await import("./SettingsTab");
  render(<SettingsTab />);
  await userEvent.click(screen.getByRole("tab", { name: tab }));
}

beforeEach(() => {
  cancelStorage.mockReset();
  cancelSeat.mockReset();
  dash.extra = {
    subscription: { tier: "pro", status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: null },
    storageAddons: [storageAddon],
    handleCancelStorageAddon: cancelStorage,
    handleCancelSeatAddon: cancelSeat,
    seatCapacity: { addons: [seatAddon], baseLimit: 2, addonSlots: 1, totalLimit: 3 },
    team: [],
    addonBusy: null,
    seatAddonBusy: null,
    invitingTeamMember: false,
    teamInviteEmail: "",
  };
});
afterEach(() => cleanup());

describe("legacy add-ons in Settings are cancel only", () => {
  it("storage: says it is no longer sold, offers Cancel for the one held, and no buy button", async () => {
    await open("Plan & billing");
    expect(screen.getByText("Storage add-ons are no longer sold. You can cancel the ones you already have, any time.")).toBeInTheDocument();
    expect(screen.getByText(/\+20GB storage/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelStorage).toHaveBeenCalledWith("st1");
    expect(screen.queryByRole("button", { name: BUY })).toBeNull();
  });

  it("seats: the add-on held has Cancel, and no button buys another seat", async () => {
    await open("Team");
    expect(screen.getByText("+1 seat")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelSeat).toHaveBeenCalledWith("se1");
    expect(screen.queryByRole("button", { name: BUY })).toBeNull();
  });

  it("with no add-ons held there is no add-on section at all", async () => {
    dash.extra = { ...dash.extra, storageAddons: [], seatCapacity: { addons: [], baseLimit: 2, addonSlots: 0, totalLimit: 2 } };
    await open("Plan & billing");
    expect(screen.queryByText(/Storage add-ons/)).toBeNull();
    expect(screen.queryByRole("button", { name: BUY })).toBeNull();
  });
});
