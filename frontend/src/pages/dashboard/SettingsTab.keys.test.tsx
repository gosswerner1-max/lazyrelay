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
const tabNames = () => within(screen.getByRole("tablist", { name: "Settings sections" })).getAllByRole("tab").map((b) => b.textContent);

afterEach(cleanup);
beforeEach(() => {
  ctx.platforms = [];
  ctx.refresh.mockReset();
  connectXKeys.mockReset();
});

describe("the Settings sub-nav is an accessible tab set", () => {
  const ALL = ["General", "Security", "Team", "Automation", "Custom developer keys", "Plan & billing"];

  it("has a tablist, tabs with aria-selected and aria-controls, and one tabpanel labelled by the selected tab", () => {
    ctx.platforms = [X_OK];
    render(<SettingsTab />);
    const tabs = within(screen.getByRole("tablist", { name: "Settings sections" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(ALL);
    const panel = screen.getByRole("tabpanel");
    for (const tab of tabs) {
      expect(tab).toHaveAttribute("aria-controls", panel.id);
      expect(tab).toHaveAttribute("aria-selected", tab.textContent === "General" ? "true" : "false");
    }
    expect(panel).toHaveAttribute("aria-labelledby", tabs[0].id);
    expect(screen.getByRole("tabpanel", { name: "General" })).toBe(panel);
  });

  it("only the selected tab is in the tab order (roving tabindex)", async () => {
    ctx.platforms = [X_OK];
    const user = userEvent.setup();
    render(<SettingsTab />);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1", "-1", "-1"]);
    await user.click(tabs[3]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1", "0", "-1", "-1"]);
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tabs[3].id);
  });

  it("ArrowRight and ArrowLeft move to the next and previous tab, wrapping round, and show its panel", async () => {
    ctx.platforms = [X_OK];
    const user = userEvent.setup();
    render(<SettingsTab />);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    tabs[0].focus();
    await user.keyboard("{ArrowRight}");
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Two-factor authentication" })).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(tabs[5]).toHaveFocus(); // wrapped from the first to the last
    expect(tabs[5]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(tabs[0]).toHaveFocus(); // and back round
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("Home and End jump to the first and last tab, and the Custom developer keys tab is reachable by arrows", async () => {
    ctx.platforms = [X_OK];
    const user = userEvent.setup();
    render(<SettingsTab />);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    tabs[0].focus();
    await user.keyboard("{End}");
    expect(tabs[5]).toHaveFocus();
    expect(tabs[5]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowLeft}");
    expect(tabs[4]).toHaveFocus();
    expect(screen.getByLabelText("API Key (Consumer Key)")).toBeInTheDocument();
    await user.keyboard("{Home}");
    expect(tabs[0]).toHaveFocus();
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("without the keys tab the arrows skip it (five tabs, wrapping at the ends)", async () => {
    const user = userEvent.setup();
    render(<SettingsTab />);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    tabs[0].focus();
    await user.keyboard("{ArrowLeft}");
    expect(tabs[4]).toHaveFocus();
    expect(tabs[4]).toHaveTextContent("Plan & billing");
  });
});

describe("the Custom developer keys sub-tab", () => {
  it("is not there at all when the backend lists neither X nor WhatsApp (feature switches off)", () => {
    render(<SettingsTab />);
    const nav = screen.getByRole("tablist", { name: "Settings sections" });
    expect(within(nav).getByRole("tab", { name: "General" })).toBeInTheDocument();
    expect(within(nav).getByRole("tab", { name: "Plan & billing" })).toBeInTheDocument();
    expect(within(nav).queryByRole("tab", KEYS_TAB)).not.toBeInTheDocument();
  });

  it("appears between Automation and Plan & billing when X is listed", () => {
    ctx.platforms = [X_OK];
    render(<SettingsTab />);
    const labels = tabNames();
    expect(labels).toEqual(["General", "Security", "Team", "Automation", "Custom developer keys", "Plan & billing"]);
  });

  it("opens the panel inside Settings, replacing the General sections", async () => {
    ctx.platforms = [X_OK];
    const user = userEvent.setup();
    render(<SettingsTab />);
    expect(screen.queryByLabelText("API Key (Consumer Key)")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", KEYS_TAB));
    expect(screen.getByRole("heading", { name: "Custom developer keys" })).toBeInTheDocument();
    expect(screen.getByLabelText("API Key (Consumer Key)")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Account" })).not.toBeInTheDocument(); // General is gone while this is open
    expect(screen.getByRole("tab", KEYS_TAB)).toHaveClass("settings-subtab-active");
  });

  it("shows the upgrade note, and no form, for a plan that does not include it", async () => {
    ctx.platforms = [WA_LOCKED];
    const user = userEvent.setup();
    render(<SettingsTab />);
    await user.click(screen.getByRole("tab", KEYS_TAB));
    expect(screen.getByText("Available on the Business plan and above.")).toBeInTheDocument();
    expect(screen.queryByLabelText("System user token")).not.toBeInTheDocument();
  });

  it("See plans on a locked card opens the Plan & billing sub-tab of the same Settings view", async () => {
    ctx.platforms = [WA_LOCKED];
    const user = userEvent.setup();
    render(<SettingsTab />);
    await user.click(screen.getByRole("tab", KEYS_TAB));
    await user.click(screen.getByRole("button", { name: "See plans" }));
    expect(screen.getByRole("tab", { name: "Plan & billing" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Available on the Business plan and above.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
  });

  it("reloads the dashboard after a connection is saved", async () => {
    ctx.platforms = [X_OK];
    connectXKeys.mockResolvedValue({ ok: true, handle: "acme", keyHint: "****2345" });
    const user = userEvent.setup();
    render(<SettingsTab />);
    await user.click(screen.getByRole("tab", KEYS_TAB));
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
    await user.click(screen.getByRole("tab", KEYS_TAB));
    expect(screen.getByLabelText("API Key (Consumer Key)")).toBeInTheDocument();
    ctx.platforms = [];
    rerender(<SettingsTab />);
    await waitFor(() => expect(screen.queryByLabelText("API Key (Consumer Key)")).not.toBeInTheDocument());
    expect(screen.queryByRole("tab", KEYS_TAB)).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "General" })).toHaveClass("settings-subtab-active");
  });
});
