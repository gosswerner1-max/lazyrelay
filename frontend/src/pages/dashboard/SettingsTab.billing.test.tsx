import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import type { CatalogItem, CatalogResult, Wallet } from "../../lib/walletApi";
import { sampleBalance, sampleCatalog } from "../../lib/walletFixtures";
import type { WalletView } from "../../lib/useWalletBalance";

// The Plan & billing view inside Settings. With VITE_BILLING_ENABLED off, or for an exempt (legacy) account, it is exactly the
// old plan cards. With billing on and a normal wallet it is the new balance card and buy panel, and the old pricing grid is gone.
// The flag is read once when the module loads, so each test sets it first and imports a fresh copy.

const getCatalog = vi.hoisted(() => vi.fn());
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
        if (key === "currentTier") return "free";
        if (/^(handle|set|setShow|refresh)/.test(key)) return vi.fn();
        return undefined;
      },
    }),
}));

const wallet = (patch: Partial<Wallet> = {}): Wallet => ({ ...(sampleBalance() as unknown as Wallet), ...patch });
const view = (patch: Partial<WalletView> = {}): WalletView => ({
  status: "ready", wallet: wallet(), error: null, fetchedAt: new Date("2026-10-20T12:00:00Z"), refresh: async () => {}, billingActive: true, ...patch,
});

async function open(flag: string | undefined, wv: WalletView) {
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
  getCatalog.mockResolvedValue({ kind: "ok", items: sampleCatalog().items as CatalogItem[] } satisfies CatalogResult);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const legacyShows = () => {
  expect(screen.getByText("Starter: 5GB storage")).toBeInTheDocument();
  expect(screen.getAllByText("(plus applicable tax)").length).toBeGreaterThan(0);
  expect(screen.queryByText("Buy credits")).toBeNull();
};

describe("Plan & billing with billing off", () => {
  it("shows today's plan cards, even if a wallet were somehow handed down, and asks for no credit options", async () => {
    await open(undefined, view());
    legacyShows();
    expect(getCatalog).not.toHaveBeenCalled();
  });

  it("stays off for any value except the word true", async () => {
    for (const flag of ["false", "1", "TRUE", ""]) {
      await open(flag, view());
      legacyShows();
      cleanup();
    }
    expect(getCatalog).not.toHaveBeenCalled();
  });
});

describe("Plan & billing with billing on", () => {
  it("shows the legacy plan cards to an exempt account", async () => {
    await open("true", view({ status: "exempt", wallet: wallet({ exempt: true }), billingActive: false }));
    legacyShows();
    expect(getCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ["loading", view({ status: "loading", wallet: null, billingActive: false })],
    ["switched off on the server", view({ status: "off", wallet: null, billingActive: false })],
    ["failed to load", view({ status: "error", wallet: null, billingActive: false, error: "x" })],
  ])("shows the legacy plan cards while the wallet is %s, with no error banner", async (_n, wv) => {
    await open("true", wv);
    legacyShows();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the balance card and the buy panel to a normal account, and hides the old pricing grid", async () => {
    await open("true", view());
    expect(await screen.findByRole("heading", { name: "Buy credits" })).toBeInTheDocument();
    expect(await screen.findByText("$9.00 plus tax")).toBeInTheDocument();
    expect(screen.getByTestId("billing-total")).toHaveTextContent("1,830");
    expect(screen.queryByText("Starter: 5GB storage")).toBeNull();
    expect(screen.queryByText("(plus applicable tax)")).toBeNull();
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).toBeNull();
  });
});
