import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../../lib/api";

// Brand add-ons are no longer sold (owner decision, 2026-10-20). The brand-limit screen must never offer to buy another
// slot, and the cancel button for an add-on that already exists must keep working.

const ctx = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  platforms: [] as Array<Record<string, unknown>>,
  subscription: { tier: "growth" } as Record<string, unknown> | null,
  disconnectingAccountId: null,
  brands: [] as Array<Record<string, unknown>>,
  newBrandName: "",
  setNewBrandName: vi.fn(),
  brandBusy: false,
  brandVoiceDrafts: {},
  setBrandVoiceDrafts: vi.fn(),
  brandVoiceBusyId: null,
  assigningAccountId: null,
  brandCapacity: null as Record<string, unknown> | null,
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
  handleCancelBrandAddon: vi.fn(),
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));
vi.mock("../../lib/supabase", () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } } }));

import { SocialPlatformsTab } from "./SocialPlatformsTab";

const fourBrands = () => [1, 2, 3, 4].map((n) => ({ id: `b${n}`, name: `Brand ${n}`, voice_profile: null }));

beforeEach(() => {
  ctx.subscription = { tier: "growth" };
  ctx.brands = fourBrands();
  ctx.brandCapacity = { addons: [], baseLimit: 4, addonSlots: 0, totalLimit: 4 };
  ctx.handleCancelBrandAddon.mockReset();
});
afterEach(cleanup);

describe("brand limit screen", () => {
  it("at the plan's brand limit there is no button to buy another brand slot", () => {
    render(<SocialPlatformsTab />);
    expect(screen.getByText(/Brands \(4\/4\)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /buy|brand slot|checkout/i })).toBeNull();
    expect(screen.queryByText(/brand slot.*\/ mo|\$10/i)).toBeNull();
  });

  it("the Add brand button is disabled at the limit", () => {
    render(<SocialPlatformsTab />);
    expect((screen.getByRole("button", { name: "Add brand" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an existing add-on is still listed and can be cancelled", async () => {
    ctx.brandCapacity = {
      addons: [{ id: "ad1", status: "active", cancel_at_period_end: false, current_period_end: null }],
      baseLimit: 4,
      addonSlots: 1,
      totalLimit: 5,
    };
    render(<SocialPlatformsTab />);
    expect(screen.getByText(/\+1 brand slot/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ctx.handleCancelBrandAddon).toHaveBeenCalledWith("ad1");
  });
});

describe("api client", () => {
  it("has no function that starts a brand, storage or seat add-on purchase", () => {
    const names = Object.keys(api);
    expect(names.filter((n) => /AddonCheckout|buy.*Addon|startBrandAddon|startSeatAddon|startStorageAddon/i.test(n))).toEqual([]);
  });

  it("keeps the cancel and list functions for existing add-ons", () => {
    expect(typeof api.cancelBrandAddon).toBe("function");
    expect(typeof api.cancelStorageAddon).toBe("function");
    expect(typeof api.cancelSeatAddon).toBe("function");
    expect(typeof api.getBrandAddons).toBe("function");
  });
});
