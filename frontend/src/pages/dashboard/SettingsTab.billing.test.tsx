import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import type { CatalogItem, CatalogResult, Wallet } from "../../lib/walletApi";
import { sampleBalance, sampleCatalog } from "../../lib/walletFixtures";
import type { WalletView } from "../../lib/useWalletBalance";

// The Plan & billing view inside Settings. The old six plan cards, their prices, the storage, seat and brand add-on buy buttons
// and the old pricing grid are gone. With billing on and a normal wallet it is the balance card and the buy panel (the new
// tiers, the packs and the spend rates). An exempt account gets one plain line, and with billing off or the wallet not loaded
// there is nothing to buy and no old prices. The flag is read once when the module loads, so each test sets it first.

const getCatalog = vi.hoisted(() => vi.fn());
const dash = vi.hoisted(() => ({ extra: {} as Record<string, unknown>, setShowCancelModal: vi.fn() }));
vi.mock("../../lib/walletApi", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/walletApi")>()), getCatalog }));
vi.mock("../../lib/supabase", () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } } }));
vi.mock("./DashboardContext", () => ({
  useDashboard: () =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, key: string) {
        if (key === "session") return { user: { email: "owner@example.com" } };
        if (key === "account") return { id: "acc1", business_name: "Acme", voice_profile: null, show_branding_tag: true, failure_alerts: true };
        if (["mediaFiles", "storageAddons", "team", "accounts", "platforms"].includes(key)) return [];
        if (key === "mediaAltTextDrafts") return {};
        if (key === "billingSectionRef") return { current: null };
        if (key === "setShowCancelModal") return dash.setShowCancelModal;
        if (key === "billingBusy") return null;
        if (key in dash.extra) return dash.extra[key];
        if (/^(handle|set|setShow|refresh)/.test(key)) return vi.fn();
        return undefined;
      },
    }),
}));

const wallet = (patch: Partial<Wallet> = {}): Wallet => ({ ...(sampleBalance() as unknown as Wallet), ...patch });
const view = (patch: Partial<WalletView> = {}): WalletView => ({
  status: "ready", wallet: wallet(), error: null, fetchedAt: new Date("2026-10-20T12:00:00Z"), refresh: async () => {}, billingActive: true, ...patch,
});

async function open(flag: string | undefined, wv: WalletView, extra: Record<string, unknown> = {}) {
  dash.extra = extra;
  vi.resetModules();
  vi.unstubAllEnvs();
  if (flag !== undefined) vi.stubEnv("VITE_BILLING_ENABLED", flag);
  const { SettingsTab } = await import("./SettingsTab");
  const { WalletContext } = await import("../../lib/walletContext");
  const ui: ReactElement = (
    <WalletContext.Provider value={wv}>
      <SettingsTab />
    </WalletContext.Provider>
  );
  render(ui);
  await userEvent.click(screen.getByRole("tab", { name: "Plan & billing" }));
}

beforeEach(() => {
  getCatalog.mockReset();
  dash.extra = {};
  dash.setShowCancelModal.mockReset();
  getCatalog.mockResolvedValue({ kind: "ok", items: sampleCatalog().items as CatalogItem[] } satisfies CatalogResult);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const OLD_PRICES = ["$29.99", "$59.99", "$99.99", "$149.99", "$199.99"];
const noOldGrid = () => {
  expect(screen.queryByText(/GB storage/)).toBeNull();
  expect(screen.queryByText("(plus applicable tax)")).toBeNull();
  expect(screen.queryByRole("button", { name: /Upgrade to|Switch to|Resubscribe|Agency plans|Add +|Buy another seat/ })).toBeNull();
  for (const p of OLD_PRICES) expect(screen.queryByText(new RegExp(p.replace("$", "\$")))).toBeNull();
};
const noCredits = () => {
  expect(screen.queryByText("Buy credits")).toBeNull();
  expect(getCatalog).not.toHaveBeenCalled();
};

describe("Plan & billing with billing off", () => {
  it("shows no plan cards and asks for no credit options, even if a wallet were somehow handed down", async () => {
    await open(undefined, view());
    noOldGrid();
    noCredits();
    expect(screen.getByText("Plans and credits are not available to buy right now.")).toBeInTheDocument();
  });

  it("stays off for any value except the word true", async () => {
    for (const flag of ["false", "1", "TRUE", ""]) {
      await open(flag, view());
      noOldGrid();
      cleanup();
    }
    expect(getCatalog).not.toHaveBeenCalled();
  });
});

describe("Plan & billing with billing on", () => {
  it("shows an exempt account one plain line, no old prices and no credit options", async () => {
    await open("true", view({ status: "exempt", wallet: wallet({ exempt: true }), billingActive: false }));
    expect(screen.getByText("Your account is set up separately, so there are no plans or credits to buy here.")).toBeInTheDocument();
    noOldGrid();
    noCredits();
  });

  it.each([
    ["loading", view({ status: "loading", wallet: null, billingActive: false })],
    ["switched off on the server", view({ status: "off", wallet: null, billingActive: false })],
    ["failed to load", view({ status: "error", wallet: null, billingActive: false, error: "x" })],
  ])("shows no old plan cards while the wallet is %s, and no error banner", async (_n, wv) => {
    await open("true", wv);
    noOldGrid();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the balance card, the new tiers, the pack and the spend rates to a normal account", async () => {
    await open("true", view());
    expect(await screen.findByRole("heading", { name: "Buy credits" })).toBeInTheDocument();
    expect(await screen.findByText("$9.00")).toBeInTheDocument();
    expect(screen.getByText("$59.99 per month")).toBeInTheDocument();
    expect(screen.getByTestId("billing-total")).toHaveTextContent("1,830");
    expect(screen.getByTestId("billing-rates")).toHaveTextContent("Publishing costs 1 credit per channel. A competitor page teardown costs 10 credits");
    noOldGrid();
  });
});

describe("Plan & billing cancel", () => {
  const paid = { subscription: { tier: "pro", status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: null } };

  it("offers Cancel subscription to a Growth or Pro wallet customer and opens the existing cancel dialog", async () => {
    await open("true", view(), {});
    await userEvent.click(await screen.findByRole("button", { name: "Cancel subscription" }));
    expect(dash.setShowCancelModal).toHaveBeenCalledWith(true);
  });

  it("does not offer it to a customer on the pay-as-you-go plan", async () => {
    const payg = wallet({ plan: { tier: "free", walletPlan: "payg", caps: { accounts: 20, brands: 2, queued: null } } });
    await open("true", view({ wallet: payg }));
    await screen.findByRole("heading", { name: "Buy credits" });
    expect(screen.queryByRole("button", { name: "Cancel subscription" })).toBeNull();
  });

  it("still offers it to an exempt account that has an older paid plan", async () => {
    await open("true", view({ status: "exempt", wallet: wallet({ exempt: true }), billingActive: false }), paid);
    expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeInTheDocument();
  });

  it("shows the pending cancellation instead of the button", async () => {
    const pending = { subscription: { ...paid.subscription, cancelAtPeriodEnd: true } };
    await open("true", view({ status: "exempt", wallet: wallet({ exempt: true }), billingActive: false }), pending);
    expect(screen.getByText(/Your plan is set to cancel/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel subscription" })).toBeNull();
  });
});
