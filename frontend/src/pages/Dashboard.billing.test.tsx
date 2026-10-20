import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { BalanceResult, Wallet } from "../lib/walletApi";
import { sampleBalance } from "../lib/walletFixtures";

// The credit wallet in the dashboard shell: the balance in the header and the plan banner wording. With VITE_BILLING_ENABLED off
// nothing is requested and nothing changes. With it on, an exempt (legacy) account, a switched-off server and a failed load all
// keep today's header and banner. Only a normal wallet gets the balance in the header and loses the old "10 posts" wording.
// The flag is read once when the module loads, so each test sets it first and imports a fresh copy.

const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const getBalance = vi.hoisted(() => vi.fn());

vi.mock("./dashboard/useDashboardState", () => ({ useDashboardState: () => state.value }));
vi.mock("../lib/walletApi", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/walletApi")>()), getBalance }));
vi.mock("../lib/supabase", () => ({ supabase: {} })); // the real client refuses to start without its address
vi.mock("./dashboard/useWhatsAppBroadcasts", () => ({ useWhatsAppBroadcasts: () => false }));
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

const baseState = () => ({
  signOut: vi.fn(), accounts: [], posts: [], pendingSelection: null, checkedOptionIds: [], setCheckedOptionIds: vi.fn(),
  platformLimit: null, setPlatformLimit: vi.fn(), account: null, loading: false, error: null, notice: null, postWarning: null,
  tab: "Overview", setTab: vi.fn(), runTour: false, showGcalPrompt: false, moreMenuOpen: false, setMoreMenuOpen: vi.fn(),
  moreMenuRef: { current: null }, tierNames: { free: "Free" }, currentTier: "free", isFreePlan: true, isPendingCancellation: false,
  isLapsedCancelled: false, isFreeOrLapsed: true, showCancelModal: false, pendingTierChange: null, showPinterestConnectModal: false,
  showMastodonServerModal: false, showWhopConnectModal: false, setScrollToBillingPending: vi.fn(), checkoutDoneCount: 0, paddle: undefined,
});

const ok = (patch: Partial<Wallet> = {}): BalanceResult => ({ kind: "ok", wallet: { ...(sampleBalance() as unknown as Wallet), ...patch } });

async function loadDashboard(flag: string | undefined) {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (flag !== undefined) vi.stubEnv("VITE_BILLING_ENABLED", flag);
  return (await import("./Dashboard")).Dashboard;
}

const FREE_LIMITS_WORDING = /3 connected accounts, 1 brand, 10 queued posts, 30 credits once/;
const BALANCE = "Available Balance: 1,830 Credits";

beforeEach(() => {
  state.value = baseState();
  getBalance.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Dashboard with billing off", () => {
  it("asks the server for nothing and shows today's banner and header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    getBalance.mockResolvedValue(ok());
    const Dashboard = await loadDashboard(undefined);
    render(<Dashboard />);
    await new Promise((r) => setTimeout(r, 50));
    expect(getBalance).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText(FREE_LIMITS_WORDING)).toBeInTheDocument();
    expect(screen.queryByText(BALANCE)).toBeNull();
    fetchSpy.mockRestore();
  });

  it("stays off for any value except the word true", async () => {
    getBalance.mockResolvedValue(ok());
    for (const flag of ["false", "1", "TRUE", ""]) {
      const Dashboard = await loadDashboard(flag);
      const { unmount } = render(<Dashboard />);
      expect(screen.getByText(FREE_LIMITS_WORDING), JSON.stringify(flag)).toBeInTheDocument();
      unmount();
    }
    expect(getBalance).not.toHaveBeenCalled();
  });
});

describe("Dashboard with billing on", () => {
  it("puts the server's balance in the header, before Guides, and drops the old '10 posts' wording", async () => {
    getBalance.mockResolvedValue(ok());
    const Dashboard = await loadDashboard("true");
    render(<Dashboard />);
    const balance = await screen.findByText(BALANCE);
    expect(screen.queryByText(FREE_LIMITS_WORDING)).toBeNull();
    const guides = screen.getByRole("link", { name: "Guides" });
    expect(balance.compareDocumentPosition(guides) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(balance.closest(".header-actions")).not.toBeNull();
    expect(getBalance).toHaveBeenCalledTimes(1);
  });

  it("keeps today's UI for an exempt (legacy) account", async () => {
    getBalance.mockResolvedValue(ok({ exempt: true }));
    const Dashboard = await loadDashboard("true");
    render(<Dashboard />);
    await waitFor(() => expect(getBalance).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(FREE_LIMITS_WORDING)).toBeInTheDocument();
    expect(screen.queryByText(BALANCE)).toBeNull();
  });

  it("keeps today's UI, with no error banner, when the server has billing off", async () => {
    getBalance.mockResolvedValue({ kind: "unavailable" });
    const Dashboard = await loadDashboard("true");
    render(<Dashboard />);
    await waitFor(() => expect(getBalance).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(FREE_LIMITS_WORDING)).toBeInTheDocument();
    expect(screen.queryByText(BALANCE)).toBeNull();
    expect(document.querySelector(".error")).toBeNull();
  });

  it("keeps today's UI when the balance cannot be loaded", async () => {
    getBalance.mockResolvedValue({ kind: "error", message: "We could not load your credits just now. Please try again.", cause: new Error("x") });
    const Dashboard = await loadDashboard("true");
    render(<Dashboard />);
    await waitFor(() => expect(getBalance).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(FREE_LIMITS_WORDING)).toBeInTheDocument();
    expect(screen.queryByText(BALANCE)).toBeNull();
  });

  it("shows today's banner while the wallet is still loading", async () => {
    getBalance.mockReturnValue(new Promise(() => {}));
    const Dashboard = await loadDashboard("true");
    render(<Dashboard />);
    expect(screen.getByText(FREE_LIMITS_WORDING)).toBeInTheDocument();
  });
});
