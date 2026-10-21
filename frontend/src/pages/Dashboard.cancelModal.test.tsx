import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// The cancel dialog's line about connected accounts. It must say only what the backend does when a plan ends:
//   billing/sync.ts          a cancel sets cancelled_at; the account cap is enforced only for an ACTIVE subscription
//   ops/accounts/data_retention_ops.js   the 30 day deletion removes scheduled posts and media files, never connected accounts
//   tier.ts, accountLimits.ts   the lapsed account resolves to Free (3 connected accounts); a NEW connection is refused at the cap
// Nothing pauses the accounts above Free's 3, so for more than 3 the dialog makes no promise. These tests pin the exact text.

const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("./dashboard/useDashboardState", () => ({ useDashboardState: () => state.value }));
vi.mock("../lib/supabase", () => ({ supabase: {} }));
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

const tierNames = { free: "Free", starter: "Starter", pro: "Pro", business: "Business", agency: "Agency", agency_plus: "Agency Plus", growth: "Growth", lazy_pro: "Pro" };
const accountsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, platform: "bluesky" }));

const baseState = () => ({
  signOut: vi.fn(), accounts: [], posts: [], pendingSelection: null, checkedOptionIds: [], setCheckedOptionIds: vi.fn(),
  platformLimit: null, setPlatformLimit: vi.fn(), account: null, loading: false, error: null, notice: null, postWarning: null,
  tab: "Overview", setTab: vi.fn(), runTour: false, showGcalPrompt: false, moreMenuOpen: false, setMoreMenuOpen: vi.fn(),
  moreMenuRef: { current: null }, tierNames, currentTier: "growth", isFreePlan: false, isPendingCancellation: false,
  isLapsedCancelled: false, isFreeOrLapsed: false, showCancelModal: true, setShowCancelModal: vi.fn(), pendingTierChange: null,
  showPinterestConnectModal: false, showMastodonServerModal: false, showWhopConnectModal: false, setScrollToBillingPending: vi.fn(),
  checkoutDoneCount: 0, paddle: undefined, periodEndDate: "Nov 20", cancelFeedback: "", setCancelFeedback: vi.fn(),
  cancelDataDeletionAck: false, setCancelDataDeletionAck: vi.fn(), handleConfirmCancelSubscription: vi.fn(), billingBusy: null,
});

async function openDialog(patch: Record<string, unknown>) {
  state.value = { ...baseState(), ...patch };
  const { Dashboard } = await import("./Dashboard");
  render(<Dashboard />);
  const dialog = screen.getByRole("heading", { name: "We're sorry to see you go" }).closest(".modal-card") as HTMLElement;
  // The first bullet is the connected accounts line.
  return within(dialog).getAllByRole("listitem")[0]!.textContent;
}

const FREE = "Your account returns to the Free plan, which includes up to 3 connected accounts.";

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  cleanup();
});

describe("the cancel dialog's connected accounts line", () => {
  it("Growth with 4 accounts: kept, Free has 3, cannot connect more, no promise they all keep posting", async () => {
    expect(await openDialog({ currentTier: "growth", accounts: accountsOf(4) })).toBe(
      `Your 4 connected accounts are not disconnected or deleted when your Growth plan ends. ${FREE} You have more than that, so you can't connect another account until you disconnect some or resubscribe, and we can't promise all of them will keep posting.`,
    );
  });

  it("Growth with 31 accounts (one over the Growth cap of 30): same true behaviour, no promise", async () => {
    expect(await openDialog({ currentTier: "growth", accounts: accountsOf(31) })).toBe(
      `Your 31 connected accounts are not disconnected or deleted when your Growth plan ends. ${FREE} You have more than that, so you can't connect another account until you disconnect some or resubscribe, and we can't promise all of them will keep posting.`,
    );
  });

  it("Growth with 0 accounts: nothing to keep", async () => {
    expect(await openDialog({ currentTier: "growth", accounts: [] })).toBe(
      "You have no connected accounts. When your Growth plan ends, your account returns to the Free plan, which includes up to 3 connected accounts.",
    );
  });

  it("Pro with 1,000 accounts (the Pro cap): number written with a separator, same behaviour", async () => {
    expect(await openDialog({ currentTier: "lazy_pro", accounts: accountsOf(1000) })).toBe(
      `Your 1,000 connected accounts are not disconnected or deleted when your Pro plan ends. ${FREE} You have more than that, so you can't connect another account until you disconnect some or resubscribe, and we can't promise all of them will keep posting.`,
    );
  });

  it("Free limit edge: 1 account is singular and fits", async () => {
    expect(await openDialog({ accounts: accountsOf(1) })).toBe(`Your 1 connected account is not disconnected or deleted when your Growth plan ends. ${FREE}`);
  });

  it("Free limit edge: 2 accounts fit under the limit", async () => {
    expect(await openDialog({ accounts: accountsOf(2) })).toBe(`Your 2 connected accounts are not disconnected or deleted when your Growth plan ends. ${FREE}`);
  });

  it("Free limit edge: exactly 3 accounts fill the limit", async () => {
    expect(await openDialog({ accounts: accountsOf(3) })).toBe(
      `Your 3 connected accounts are not disconnected or deleted when your Growth plan ends. ${FREE} That limit is full, so you can't connect another account until you disconnect one or resubscribe.`,
    );
  });

  it("names an older plan by its tier", async () => {
    const text = await openDialog({ currentTier: "business", accounts: accountsOf(2) });
    expect(text).toContain("when your Business plan ends");
  });

  it("cancelPlanName prefers the live wallet plan, then the tier, then a neutral word", async () => {
    const { cancelPlanName } = await import("../components/dashboard/CancelAccountsNote");
    expect(cancelPlanName("lazy_pro", "growth")).toBe("Growth");
    expect(cancelPlanName("growth", "pro")).toBe("Pro");
    expect(cancelPlanName("growth", "payg")).toBe("Growth");
    expect(cancelPlanName("agency_plus", null)).toBe("Agency Plus");
    expect(cancelPlanName(undefined, null)).toBe("current");
  });

  it("never says the accounts are lost, and never asks to reconnect them", async () => {
    for (const n of [0, 1, 3, 4, 31, 1000]) {
      const text = await openDialog({ accounts: accountsOf(n) });
      expect(text).not.toMatch(/lose|reconnect|deleted permanently/i);
      cleanup();
      vi.resetModules();
    }
  });

  it("keeps the other two bullets, and the dialog offers no add-on purchase button", async () => {
    await openDialog({ accounts: accountsOf(4) });
    expect(screen.getByText(/You'll keep access until Nov 20/)).toBeInTheDocument();
    expect(screen.getByText(/30 days after your access ends/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /buy|purchase|add storage|add a seat|brand slot|add-on/i })).toBeNull();
  });
});
