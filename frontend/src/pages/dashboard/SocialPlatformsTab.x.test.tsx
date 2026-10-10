import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { byokBadge, xTileState } from "../../lib/xByok";

const ctx = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  platforms: [] as Array<Record<string, unknown>>,
  subscription: null,
  disconnectingAccountId: null,
  brands: [],
  newBrandName: "",
  setNewBrandName: vi.fn(),
  brandBusy: false,
  brandVoiceDrafts: {},
  setBrandVoiceDrafts: vi.fn(),
  brandVoiceBusyId: null,
  assigningAccountId: null,
  brandCapacity: null,
  brandAddonBusy: null,
  connectingPlatform: null,
  setShowPinterestConnectModal: vi.fn(),
  setShowMastodonServerModal: vi.fn(),
  setShowWhopConnectModal: vi.fn(),
  handleConnect: vi.fn(),
  handleDisconnectAccount: vi.fn(),
  handleCreateBrand: vi.fn(),
  handleDeleteBrand: vi.fn(),
  handleSaveBrandVoice: vi.fn(),
  handleAssignBrand: vi.fn(),
  handleBuyBrandAddon: vi.fn(),
  handleCancelBrandAddon: vi.fn(),
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));
vi.mock("../../lib/supabase", () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } } }));

import { SocialPlatformsTab } from "./SocialPlatformsTab";

const assign = vi.fn();
beforeEach(() => {
  ctx.accounts = [];
  ctx.handleConnect.mockReset();
  assign.mockReset();
  Object.defineProperty(window, "location", { value: { ...window.location, assign, href: "http://localhost/" }, writable: true });
});
afterEach(cleanup);

describe("the gate states, as the server reports them", () => {
  it("xTileState reflects allowed and requiresPlan and never decides itself", () => {
    expect(xTileState({ allowed: false, requiresPlan: "Pro" })).toEqual({ kind: "upgrade", label: "Upgrade to Pro" });
    expect(xTileState({ allowed: true, requiresPlan: "Pro" })).toEqual({ kind: "connect" });
    expect(xTileState({})).toEqual({ kind: "connect" }); // an older server that sends no gate fields
  });
  it("byokBadge only speaks for the two problem states", () => {
    expect(byokBadge("invalid")?.text).toBe("Keys not accepted");
    expect(byokBadge("out_of_credit")?.text).toBe("Out of X credit");
    expect(byokBadge("valid")).toBeNull();
    expect(byokBadge(null)).toBeNull();
    expect(byokBadge(undefined)).toBeNull();
  });
});

describe("the X tile", () => {
  it("is locked with 'Upgrade to Pro' when the plan does not include it, and sends the customer to pricing", async () => {
    ctx.platforms = [{ platform: "x", configured: true, comingSoon: false, requiresPlan: "Pro", allowed: false }];
    render(<SocialPlatformsTab />);
    expect(screen.getByText("Upgrade to Pro")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /x/i }));
    expect(assign).toHaveBeenCalledWith("/pricing");
    expect(ctx.handleConnect).not.toHaveBeenCalled();
  });

  it("is open on an allowed plan and goes to the keys page, never through the OAuth redirect", async () => {
    ctx.platforms = [{ platform: "x", configured: true, comingSoon: false, requiresPlan: "Pro", allowed: true }];
    render(<SocialPlatformsTab />);
    expect(screen.queryByText("Upgrade to Pro")).toBeNull();
    expect(screen.queryByText("Coming soon")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /x/i }));
    expect(assign).toHaveBeenCalledWith("/connect/x");
    expect(ctx.handleConnect).not.toHaveBeenCalled();
  });

  it("shows a badge on a connected X account whose keys were refused or ran out of credit", async () => {
    ctx.platforms = [{ platform: "x", configured: true, comingSoon: false, requiresPlan: "Pro", allowed: true }];
    ctx.accounts = [
      { id: "a1", platform: "x", display_name: "acme", platform_account_id: "1", brand_id: null, brand_label: null, connected_at: "2026-10-01", byokStatus: "out_of_credit", byokKeyHint: "****abcd" },
      { id: "a2", platform: "x", display_name: "other", platform_account_id: "2", brand_id: null, brand_label: null, connected_at: "2026-10-01", byokStatus: "invalid" },
      { id: "a3", platform: "x", display_name: "fine", platform_account_id: "3", brand_id: null, brand_label: null, connected_at: "2026-10-01", byokStatus: "valid" },
    ];
    render(<SocialPlatformsTab />);
    await userEvent.click(document.querySelector(".account-picker-group-header") as HTMLElement); // groups start collapsed
    expect(screen.getAllByText("Out of X credit")).toHaveLength(1);
    expect(screen.getAllByText("Keys not accepted")).toHaveLength(1);
  });
});
