import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CatalogResult, Wallet } from "../../lib/walletApi";
import { sampleBalance, sampleCatalog } from "../../lib/walletFixtures";
import { capsLine } from "../../lib/walletFormat";
import { WalletContext } from "../../lib/walletContext";
import type { WalletView } from "../../lib/useWalletBalance";
import { DashboardContext, type DashboardState } from "../../pages/dashboard/DashboardContext";

vi.mock("../../lib/supabase", () => ({ supabase: {} })); // the real client refuses to start without its address

import { BalanceIndicator } from "./BalanceIndicator";
import { BillingCard } from "./BillingCard";
import HeaderBalance from "./HeaderBalance";
import LiveBilling, { LiveBillingView } from "./LiveBilling";

afterEach(cleanup);

const NOW = new Date("2026-10-20T12:00:00Z");
const wallet = (patch: Partial<Wallet> = {}): Wallet => ({ ...(sampleBalance() as unknown as Wallet), ...patch });
const catalog = async (): Promise<CatalogResult> => ({ kind: "ok", items: sampleCatalog().items as never });
const view = (patch: Partial<WalletView> = {}): WalletView => ({
  status: "ready", wallet: wallet(), error: null, fetchedAt: NOW, refresh: async () => {}, billingActive: true, ...patch,
});

describe("balance shown from the server's number", () => {
  it("the header indicator shows the given total, not the sum of the lots", () => {
    render(<BalanceIndicator lots={[{ kind: "pack", remaining: 5, expiresAt: null }]} now={NOW} total={1830} />);
    expect(screen.getByText("Available Balance: 1,830 Credits")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Balance is high" })).toBeInTheDocument();
  });

  it("the billing card shows the given total", () => {
    render(<BillingCard lots={[]} now={NOW} total={42} />);
    expect(screen.getByTestId("billing-total")).toHaveTextContent("42");
  });

  it("the card's main button calls onBuy and shows no 'not switched on' note when it is given one", async () => {
    const onBuy = vi.fn();
    render(<BillingCard lots={[]} now={NOW} onBuy={onBuy} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy Credits / Upgrade Plan" }));
    expect(onBuy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Billing is not switched on yet.")).toBeNull();
  });
});

describe("capsLine", () => {
  it("says what the plan allows and 'No brand limit' only when brands is null", () => {
    expect(capsLine({ accounts: 30, brands: null, queued: 200 })).toBe("30 accounts, No brand limit, 200 queued posts");
    expect(capsLine({ accounts: 1, brands: 1, queued: null })).toBe("1 account, 1 brand");
    expect(capsLine({ accounts: 5, brands: 3, queued: 1 })).toBe("5 accounts, 3 brands, 1 queued post");
  });
  it("never says unlimited", () => {
    expect(capsLine({ accounts: 5, brands: null, queued: null })).not.toMatch(/unlimited/i);
  });
});

describe("LiveBillingView", () => {
  it("feeds the real lots to the card: the plan resets, the top-up is linked, credits come from the server's balance", async () => {
    render(<LiveBillingView wallet={wallet()} now={NOW} paddle={undefined} loadCatalog={catalog} />);
    expect(screen.getByTestId("billing-total")).toHaveTextContent("1,830");
    const plan = screen.getByRole("region", { name: "Subscription Plan" });
    expect(within(plan).getByText("1,200 credits")).toBeInTheDocument();
    expect(within(plan).getByText("Resets in 21 days on 2026-11-10")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Pro Top-Up Pack" })).getByText("500 credits")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Pay-As-You-Go" })).getByText("includes 30 free sign-up credits")).toBeInTheDocument();
    await screen.findByText("Credit Pack");
  });

  it("says Ends in when the server says the plan will not renew", async () => {
    const w = wallet({ lots: [{ kind: "subscription", remaining: 10, expiresAt: "2026-11-01T12:00:00Z", autoRenew: false, planName: "Pro" }] });
    render(<LiveBillingView wallet={w} now={NOW} paddle={undefined} loadCatalog={catalog} />);
    expect(screen.getByText("Ends in 12 days on 2026-11-01")).toBeInTheDocument();
    await screen.findByText("Credit Pack");
  });

  it("shows the expiry banner only inside seven days", async () => {
    const soon = wallet({ lots: [{ kind: "subscription", remaining: 10, expiresAt: "2026-10-23T12:00:00Z", autoRenew: true, planName: "Pro" }] });
    const { unmount } = render(<LiveBillingView wallet={soon} now={NOW} paddle={undefined} loadCatalog={catalog} />);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Your Pro Plan credits expire in 3 days (2026-10-23).");
    unmount();
    render(<LiveBillingView wallet={wallet()} now={NOW} paddle={undefined} loadCatalog={catalog} />);
    expect(screen.queryByText(/credits expire in/)).toBeNull();
    await screen.findByText("Credit Pack");
  });

  it("shows the plan line with 'No brand limit' where the server says brands is null", async () => {
    render(<LiveBillingView wallet={wallet()} now={NOW} paddle={undefined} loadCatalog={catalog} />);
    expect(screen.getByText("30 accounts, No brand limit, 200 queued posts")).toBeInTheDocument();
    await screen.findByText("Credit Pack");
  });

  it("the card's main button brings the buy panel into view", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<LiveBillingView wallet={wallet()} now={NOW} paddle={undefined} loadCatalog={catalog} />);
    await screen.findByText("Credit Pack");
    await userEvent.click(screen.getByRole("button", { name: "Buy Credits / Upgrade Plan" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("has the buy panel with 'plus tax' beside the prices and no promise it cannot keep", async () => {
    render(<LiveBillingView wallet={wallet()} now={NOW} paddle={undefined} loadCatalog={catalog} />);
    await screen.findByText("Credit Pack");
    expect(screen.getByText("$9.00 plus tax")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/instant|unlimited|uptime|guarantee/i);
    expect(document.body.textContent).not.toMatch(/10 posts per connected account/);
  });
});

describe("LiveBilling and HeaderBalance read the shared wallet", () => {
  const dash = { paddle: { Checkout: { open: vi.fn() } } } as unknown as DashboardState;
  const inContexts = (ui: React.ReactNode, wv: WalletView) => (
    <DashboardContext.Provider value={dash}>
      <WalletContext.Provider value={wv}>{ui}</WalletContext.Provider>
    </DashboardContext.Provider>
  );

  it("the header chip shows the server balance when billing is active", () => {
    render(inContexts(<HeaderBalance />, view()));
    expect(screen.getByText("Available Balance: 1,830 Credits")).toBeInTheDocument();
  });

  it.each([
    ["off", view({ status: "off", wallet: null, billingActive: false })],
    ["exempt", view({ status: "exempt", wallet: wallet({ exempt: true }), billingActive: false })],
    ["loading", view({ status: "loading", wallet: null, billingActive: false })],
    ["error", view({ status: "error", wallet: null, billingActive: false, error: "x" })],
  ])("the header chip renders nothing when the wallet is %s", (_n, wv) => {
    const { container } = render(inContexts(<HeaderBalance />, wv));
    expect(container).toBeEmptyDOMElement();
  });

  it("LiveBilling renders nothing without a loaded wallet", () => {
    const { container } = render(inContexts(<LiveBilling />, view({ wallet: null, billingActive: false })));
    expect(container).toBeEmptyDOMElement();
  });
});
