import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The Custom Developer Keys sub-tab inside Settings: shown only when the backend lists X or WhatsApp for this account,
// mounts the panel, and reloads the dashboard after a connection is saved. The rest of the dashboard state is a stub.

const ctx = vi.hoisted(() => ({
  platforms: [] as Array<Record<string, unknown>>,
  refresh: vi.fn(),
}));

/** Every field SettingsTab reads that the test does not set: handlers and setters become no-op functions, everything
 *  else is a harmless empty value. Only `platforms` and `refresh` matter here. */
const base: Record<string, unknown> = {
  session: { user: { email: "owner@example.com" } },
  subscription: null,
  storageUsage: null,
  mediaFiles: [],
  storageAddons: [],
  account: { id: "acc1", business_name: "Acme", voice_profile: null, show_branding_tag: true, failure_alerts: true },
  team: [],
  accounts: [],
  currentTier: "business",
  mediaAltTextDrafts: {},
  billingSectionRef: { current: null },
  scrollToBillingPending: false,
  seatCapacity: null,
  businessNameInput: "",
  voiceProfileInput: "",
  teamInviteEmail: "",
  mfaVerifyCode: "",
  mfaRecoveryCodes: null,
  mfaEnrollment: null,
  mfaFactorId: null,
  gcalStatus: null,
  gsheetStatus: null,
  adminWindowExpiresAt: null,
};
vi.mock("./DashboardContext", () => ({
  useDashboard: () =>
    new Proxy(ctx, {
      get(target, key: string) {
        if (key in target) return (target as Record<string, unknown>)[key];
        if (key in base) return base[key];
        if (/^(handle|set|setShow)/.test(key)) return vi.fn();
        return undefined;
      },
    }),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } } }));

const connectXKeys = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, connectXKeys } };
});

import { SettingsTab } from "./SettingsTab";

const X_OK = { platform: "x", configured: true, comingSoon: false, requiresPlan: "Pro", allowed: true };
const WA_LOCKED = { platform: "whatsapp", configured: true, comingSoon: false, requiresPlan: "Business", allowed: false };
const KEYS_TAB = { name: "Custom developer keys" };

afterEach(cleanup);
beforeEach(() => {
  ctx.platforms = [];
  ctx.refresh.mockReset();
  connectXKeys.mockReset();
});

describe("the Custom developer keys sub-tab", () => {
  it("is not there at all when the backend lists neither X nor WhatsApp (feature switches off)", () => {
    render(<SettingsTab />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("button", { name: "General" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Plan & billing" })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", KEYS_TAB)).not.toBeInTheDocument();
  });

  it("appears between Automation and Plan & billing when X is listed", () => {
    ctx.platforms = [X_OK];
    render(<SettingsTab />);
    const labels = within(screen.getByRole("navigation", { name: "Settings sections" }))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual(["General", "Security", "Team", "Automation", "Custom developer keys", "Plan & billing"]);
  });

  it("opens the panel inside Settings, replacing the General sections", async () => {
    ctx.platforms = [X_OK];
    const user = userEvent.setup();
    render(<SettingsTab />);
    expect(screen.queryByLabelText("API Key (Consumer Key)")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", KEYS_TAB));
    expect(screen.getByRole("heading", { name: "Custom developer keys" })).toBeInTheDocument();
    expect(screen.getByLabelText("API Key (Consumer Key)")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Account" })).not.toBeInTheDocument(); // General is gone while this is open
    expect(screen.getByRole("button", KEYS_TAB)).toHaveClass("settings-subtab-active");
  });

  it("shows the upgrade note, and no form, for a plan that does not include it", async () => {
    ctx.platforms = [WA_LOCKED];
    const user = userEvent.setup();
    render(<SettingsTab />);
    await user.click(screen.getByRole("button", KEYS_TAB));
    expect(screen.getByText("Available on the Business plan and above.")).toBeInTheDocument();
    expect(screen.queryByLabelText("System user token")).not.toBeInTheDocument();
  });

  it("reloads the dashboard after a connection is saved", async () => {
    ctx.platforms = [X_OK];
    connectXKeys.mockResolvedValue({ ok: true, handle: "acme", keyHint: "****2345" });
    const user = userEvent.setup();
    render(<SettingsTab />);
    await user.click(screen.getByRole("button", KEYS_TAB));
    await user.type(screen.getByLabelText("API Key (Consumer Key)"), "fakeApiKey12345");
    await user.type(screen.getByLabelText("API Secret (Consumer Secret)"), "fakeApiSecret12345");
    await user.type(screen.getByLabelText("Access Token"), "99-fakeAccessToken123");
    await user.type(screen.getByLabelText("Access Token Secret"), "fakeTokenSecret12345");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(connectXKeys).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalledTimes(1));
  });

  it("falls back to General if the platforms disappear while the sub-tab is open", async () => {
    ctx.platforms = [X_OK];
    const user = userEvent.setup();
    const { rerender } = render(<SettingsTab />);
    await user.click(screen.getByRole("button", KEYS_TAB));
    expect(screen.getByLabelText("API Key (Consumer Key)")).toBeInTheDocument();
    ctx.platforms = [];
    rerender(<SettingsTab />);
    await waitFor(() => expect(screen.queryByLabelText("API Key (Consumer Key)")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", KEYS_TAB)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "General" })).toHaveClass("settings-subtab-active");
  });
});
