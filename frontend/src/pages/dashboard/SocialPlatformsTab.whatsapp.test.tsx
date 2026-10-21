import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const ctx = vi.hoisted(() => ({
  accounts: [{ id: "w1", platform: "whatsapp", display_name: "Test", platform_account_id: "1", brand_id: null, brand_label: null, connected_at: "2026-10-16" }] as Array<Record<string, unknown>>,
  platforms: [{ platform: "whatsapp", configured: true, comingSoon: false, requiresPlan: "Starter", allowed: true }] as Array<Record<string, unknown>>,
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
  handleCancelBrandAddon: vi.fn(),
}));
vi.mock("./DashboardContext", () => ({ useDashboard: () => ctx }));
vi.mock("../../lib/supabase", () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } } }));

import { SocialPlatformsTab } from "./SocialPlatformsTab";

afterEach(cleanup);

describe("the WhatsApp tile", () => {
  it("shows its logo and reads WhatsApp with a capital A", () => {
    render(<SocialPlatformsTab />);
    const tile = document.querySelector(".platform-tile") as HTMLElement;
    expect(tile.textContent).toContain("WhatsApp");
    expect(tile.textContent).not.toContain("Whatsapp");
    expect(tile.querySelector("svg")).not.toBeNull();
    expect(tile.querySelector("svg circle[fill='none']")).toBeNull(); // the placeholder is a hollow circle
  });
});
