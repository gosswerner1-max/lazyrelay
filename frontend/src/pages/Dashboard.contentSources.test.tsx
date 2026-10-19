import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The Content Sources tab sits behind a build-time flag (VITE_CONTENT_SOURCES_ENABLED === "true", default off). The flag is read
// once when Dashboard.tsx loads, so each test sets it first and then imports a fresh copy of the module.

const state = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  setTab: vi.fn(),
}));

vi.mock("./dashboard/useDashboardState", () => ({ useDashboardState: () => state.value }));
vi.mock("../lib/supabase", () => ({ supabase: {} })); // the real client refuses to start without its address
vi.mock("./dashboard/useWhatsAppBroadcasts", () => ({ useWhatsAppBroadcasts: () => false }));
// Everything that is not the nav is stood in for, so only the shell is under test.
vi.mock("../components/ProductTour", () => ({ ProductTour: () => null }));
vi.mock("../components/SupportWidget", () => ({ SupportWidget: () => null }));
vi.mock("../components/CircuitBackground", () => ({ CircuitBackground: () => null }));
vi.mock("../components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("../components/PinterestConnectModal", () => ({ PinterestConnectModal: () => null }));
vi.mock("../components/MastodonServerModal", () => ({ MastodonServerModal: () => null }));
vi.mock("../components/WhopConnectModal", () => ({ WhopConnectModal: () => null }));
vi.mock("./dashboard/AnalyticsTab", () => ({ AnalyticsTab: () => null }));
vi.mock("./dashboard/MentionsTab", () => ({ MentionsTab: () => null }));
vi.mock("./dashboard/DmsTab", () => ({ DmsTab: () => null }));
vi.mock("./dashboard/BioPageTab", () => ({ BioPageTab: () => null }));
vi.mock("./dashboard/OverviewTab", () => ({ OverviewTab: () => null }));
vi.mock("./dashboard/SocialPlatformsTab", () => ({ SocialPlatformsTab: () => null }));
vi.mock("./dashboard/PostsTab", () => ({ PostsTab: () => null }));
vi.mock("./dashboard/FailedTab", () => ({ FailedTab: () => null }));
vi.mock("./dashboard/CalendarTab", () => ({ CalendarTab: () => null }));
vi.mock("./dashboard/SettingsTab", () => ({ SettingsTab: () => null }));
vi.mock("./dashboard/ApiKeysTab", () => ({ ApiKeysTab: () => null }));
vi.mock("./dashboard/WhatsAppTab", () => ({ WhatsAppTab: () => null }));
vi.mock("./dashboard/ContentSourcesTabConnected", () => ({ default: () => <div data-testid="cs-tab">Content Sources panel</div> }));

function baseState(tab: string) {
  return {
    signOut: vi.fn(),
    accounts: [],
    posts: [],
    pendingSelection: null,
    checkedOptionIds: [],
    setCheckedOptionIds: vi.fn(),
    platformLimit: null,
    setPlatformLimit: vi.fn(),
    account: null,
    loading: false,
    error: null,
    notice: null,
    postWarning: null,
    tab,
    setTab: state.setTab,
    runTour: false,
    showGcalPrompt: false,
    moreMenuOpen: false,
    setMoreMenuOpen: vi.fn(),
    moreMenuRef: { current: null },
    tierNames: { free: "Free" },
    currentTier: "free",
    isFreePlan: false,
    isPendingCancellation: false,
    isLapsedCancelled: false,
    isFreeOrLapsed: false,
    showCancelModal: false,
    pendingTierChange: null,
    showPinterestConnectModal: false,
    showMastodonServerModal: false,
    showWhopConnectModal: false,
  };
}

async function loadDashboard(flag: string | undefined) {
  vi.resetModules();
  if (flag === undefined) vi.unstubAllEnvs();
  else vi.stubEnv("VITE_CONTENT_SOURCES_ENABLED", flag);
  return (await import("./Dashboard")).Dashboard;
}

const navNames = () => within(document.querySelector("nav.tab-bar") as HTMLElement).getAllByRole("button").map((b) => b.textContent?.replace(/\s*▾$/, "").trim());

beforeEach(() => {
  state.setTab.mockReset();
  state.value = baseState("Overview");
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Content Sources tab flag", () => {
  it("is absent by default: the tab bar is exactly the existing one", async () => {
    const Dashboard = await loadDashboard(undefined);
    render(<Dashboard />);
    expect(navNames()).toEqual(["Overview", "Posts", "Failed", "Calendar", "Social Platforms", "API Keys", "Settings", "More"]);
  });

  it("is absent when the flag is anything other than the word true", async () => {
    for (const flag of ["false", "1", "TRUE", ""]) {
      const Dashboard = await loadDashboard(flag);
      const { unmount } = render(<Dashboard />);
      expect(navNames(), `flag ${JSON.stringify(flag)}`).not.toContain("Content Sources");
      unmount();
    }
  });

  it("does not render the panel by default even if the tab name were selected", async () => {
    state.value = baseState("Content Sources");
    const Dashboard = await loadDashboard(undefined);
    render(<Dashboard />);
    expect(screen.queryByTestId("cs-tab")).toBeNull();
  });

  it("appears directly after Calendar when the flag is true", async () => {
    const Dashboard = await loadDashboard("true");
    render(<Dashboard />);
    expect(navNames()).toEqual(["Overview", "Posts", "Failed", "Calendar", "Content Sources", "Social Platforms", "API Keys", "Settings", "More"]);
  });

  it("opens the panel when pressed and shows it when selected", async () => {
    const Dashboard = await loadDashboard("true");
    const { unmount } = render(<Dashboard />);
    await userEvent.click(screen.getByRole("button", { name: "Content Sources" }));
    expect(state.setTab).toHaveBeenCalledWith("Content Sources");
    unmount();
    state.value = baseState("Content Sources");
    render(<Dashboard />);
    expect(await screen.findByTestId("cs-tab")).toBeInTheDocument();
  });
});
