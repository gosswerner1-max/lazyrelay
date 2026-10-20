import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CatalogItem, CatalogResult } from "../../lib/walletApi";
import type { CheckoutResult } from "../../lib/walletCheckout";
import { sampleCatalog } from "../../lib/walletFixtures";

vi.mock("../../lib/supabase", () => ({ supabase: {} })); // the real client refuses to start without its address

import { BuyPanel } from "./BuyPanel";

afterEach(cleanup);

const items = () => sampleCatalog().items as CatalogItem[];
const catalogOf = (list: CatalogItem[]): (() => Promise<CatalogResult>) => async () => ({ kind: "ok", items: list });
const paddleFake = () => ({ Checkout: { open: vi.fn() } });
const started = (id = "txn_1"): CheckoutResult => ({ ok: true, transactionId: id, checkoutUrl: "https://pay.example", sku: "x" });
const item = (name: string) => screen.getByRole("listitem", { name });

describe("BuyPanel catalog", () => {
  it("shows 'plus tax' directly beside every price", async () => {
    render(<BuyPanel paddle={paddleFake()} loadCatalog={catalogOf(items())} start={vi.fn()} />);
    await screen.findByText("Credit Pack");
    const prices = document.querySelectorAll(".bm-buy__price");
    expect(prices.length).toBe(2); // the third item is not purchasable, so it shows a reason and no price
    for (const p of prices) expect(p.textContent).toMatch(/\$[\d,.]+ plus tax/);
    expect(prices[0]!.textContent).toBe("$9.00 plus tax");
  });

  it("labels a subscription 'per month' with 'credits expire each billing cycle'", async () => {
    render(<BuyPanel paddle={paddleFake()} loadCatalog={catalogOf(items())} start={vi.fn()} />);
    const plan = within(await screen.findByRole("listitem", { name: "Pro Plan" }));
    expect(plan.getByText(/^\$59\.99 plus tax per month$/)).toBeInTheDocument();
    expect(plan.getByText("1,200 credits")).toBeInTheDocument();
    expect(plan.getByText("credits expire each billing cycle")).toBeInTheDocument();
  });

  it("labels a pack that never expires 'credits never expire'", async () => {
    render(<BuyPanel paddle={paddleFake()} loadCatalog={catalogOf(items())} start={vi.fn()} />);
    const pack = within(await screen.findByRole("listitem", { name: "Credit Pack" }));
    expect(pack.getByText("300 credits")).toBeInTheDocument();
    expect(pack.getByText("credits never expire")).toBeInTheDocument();
    expect(pack.queryByText(/per month/)).toBeNull();
  });

  it("shows a purchasable Pro top-up with the plan-bound text, plus tax, and never 'never expire'", async () => {
    const list = items();
    list[2] = { ...list[2]!, purchasable: true, reason: null, expires: false };
    render(<BuyPanel paddle={paddleFake()} loadCatalog={catalogOf(list)} start={vi.fn()} />);
    const topup = within(await screen.findByRole("listitem", { name: "Pro Top-Up" }));
    expect(topup.getByText("$25 for 500 credits (bound to active subscription status, expires if canceled).")).toBeInTheDocument();
    expect(topup.getByText("Plus tax.")).toBeInTheDocument();
    expect(topup.queryByText(/never expire/)).toBeNull();
    expect(topup.getByRole("button", { name: "Buy Pro Top-Up" })).toBeEnabled();
  });

  it("keeps the plan-bound text beside the Pro-only reason line when the top-up cannot be bought", async () => {
    render(<BuyPanel paddle={paddleFake()} loadCatalog={catalogOf(items())} start={vi.fn()} />);
    const topup = within(await screen.findByRole("listitem", { name: "Pro Top-Up" }));
    expect(topup.getByText(/bound to active subscription status, expires if canceled\)\.$/)).toBeInTheDocument();
    expect(topup.getByText("Only for active Pro plan subscribers.")).toBeInTheDocument();
    expect(topup.queryByText(/never expire/)).toBeNull();
  });

  it("shows the pay-as-you-go pack as exactly two lines and no 'never expire' wording", async () => {
    const list = items();
    list[0] = { ...list[0]!, sku: "lazycredits-starter-pack", name: "Pay-as-you-go", priceCents: 1500 };
    render(<BuyPanel paddle={paddleFake()} loadCatalog={catalogOf(list)} start={vi.fn()} />);
    const payg = within(await screen.findByRole("listitem", { name: "Pay-as-you-go" }));
    expect(payg.getByText("$15.00 plus tax")).toBeInTheDocument();
    expect(payg.getByText("300 credits that stay in your wallet until used")).toBeInTheDocument();
    expect(payg.getByText("Balance can be topped up at any time")).toBeInTheDocument();
    expect(payg.queryByText(/never expire|Pay once/)).toBeNull();
  });

  it.each([
    ["needs_pro", "Only for active Pro plan subscribers."],
    ["already_subscribed", "You are already subscribed to this plan."],
    ["legacy_account", "Not available on your current account type."],
    ["plan_ending", "Your Pro plan is set to end, so a top-up would lapse in days."],
    [null, "Not available right now."],
  ] as const)("replaces the Buy button with a one-line reason: %s", async (reason, line) => {
    const list = items();
    list[2] = { ...list[2]!, purchasable: false, reason };
    render(<BuyPanel paddle={paddleFake()} loadCatalog={catalogOf(list)} start={vi.fn()} />);
    const topup = within(await screen.findByRole("listitem", { name: "Pro Top-Up" }));
    expect(topup.getByText(line)).toBeInTheDocument();
    expect(topup.queryByRole("button")).toBeNull();
    expect(topup.queryByText(/plus tax/)).toBeNull();
  });

  it("says loading first, then lists the items", async () => {
    render(<BuyPanel paddle={paddleFake()} loadCatalog={catalogOf(items())} start={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading credit options...");
    await screen.findByText("Credit Pack");
    expect(screen.queryByText("Loading credit options...")).toBeNull();
  });

  it("renders nothing when the server says the catalog is unavailable (billing off)", async () => {
    const { container } = render(<BuyPanel paddle={paddleFake()} loadCatalog={async () => ({ kind: "unavailable" })} start={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("Loading credit options...")).toBeNull());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows friendly words with a Try again button when the catalog fails to load, and recovers", async () => {
    const load = vi
      .fn<() => Promise<CatalogResult>>()
      .mockResolvedValueOnce({ kind: "error", message: "We could not load the credit options just now. Please try again.", cause: new Error("x") })
      .mockResolvedValueOnce({ kind: "ok", items: items() });
    render(<BuyPanel paddle={paddleFake()} loadCatalog={load} start={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not load the credit options just now. Please try again.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Credit Pack")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("BuyPanel buying", () => {
  it("starts the checkout for the clicked item and opens the payment window with the transaction", async () => {
    const paddle = paddleFake();
    const start = vi.fn(async () => started("txn_77"));
    render(<BuyPanel paddle={paddle} loadCatalog={catalogOf(items())} start={start} />);
    await userEvent.click(await screen.findByRole("button", { name: "Buy Credit Pack" }));
    expect(start).toHaveBeenCalledWith("pack_small");
    await waitFor(() => expect(paddle.Checkout.open).toHaveBeenCalledWith({ transactionId: "txn_77" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Buy Credit Pack" })).toBeEnabled());
  });

  it("is double-click safe: disabled while pending, one request only", async () => {
    let finish!: (r: CheckoutResult) => void;
    const start = vi.fn(() => new Promise<CheckoutResult>((resolve) => (finish = resolve)));
    const paddle = paddleFake();
    render(<BuyPanel paddle={paddle} loadCatalog={catalogOf(items())} start={start} />);
    const buy = await screen.findByRole("button", { name: "Buy Credit Pack" });
    await userEvent.dblClick(buy);
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Buy Credit Pack" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Buy Pro Plan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Buy Credit Pack" })).toHaveTextContent("Starting checkout...");
    finish(started());
    await waitFor(() => expect(paddle.Checkout.open).toHaveBeenCalledTimes(1));
  });

  it("shows the refusal words as an alert and does not open the payment window", async () => {
    const paddle = paddleFake();
    const start = vi.fn(async (): Promise<CheckoutResult> => ({ ok: false, message: "The Pro top-up is only for active Pro plan subscribers.", code: "needs_pro" }));
    render(<BuyPanel paddle={paddle} loadCatalog={catalogOf(items())} start={start} />);
    await userEvent.click(await screen.findByRole("button", { name: "Buy Credit Pack" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The Pro top-up is only for active Pro plan subscribers.");
    expect(paddle.Checkout.open).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Buy Credit Pack" })).toBeEnabled();
  });

  it("clears an old problem when the next attempt succeeds", async () => {
    const start = vi
      .fn<(sku: string) => Promise<CheckoutResult>>()
      .mockResolvedValueOnce({ ok: false, message: "We could not start the checkout. Please try again." })
      .mockResolvedValueOnce(started());
    render(<BuyPanel paddle={paddleFake()} loadCatalog={catalogOf(items())} start={start} />);
    const buy = await screen.findByRole("button", { name: "Buy Credit Pack" });
    await userEvent.click(buy);
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Buy Credit Pack" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("says the payment window could not load when Paddle is missing, and does not redirect", async () => {
    const start = vi.fn(async () => started());
    render(<BuyPanel paddle={undefined} loadCatalog={catalogOf(items())} start={start} />);
    await userEvent.click(await screen.findByRole("button", { name: "Buy Credit Pack" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The payment window could not load. Please refresh the page and try again.");
  });

  it("says the same when opening the window throws, and never shows the raw error", async () => {
    const paddle = { Checkout: { open: vi.fn(() => { throw new Error("TypeError: x is undefined at paddle.js:1"); }) } };
    render(<BuyPanel paddle={paddle} loadCatalog={catalogOf(items())} start={vi.fn(async () => started())} />);
    await userEvent.click(await screen.findByRole("button", { name: "Buy Credit Pack" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The payment window could not load. Please refresh the page and try again.");
    expect(alert).not.toHaveTextContent("paddle.js");
    expect(screen.getByRole("button", { name: "Buy Credit Pack" })).toBeEnabled();
  });

  it("says nothing about instant delivery, unlimited use or uptime", async () => {
    render(<BuyPanel paddle={paddleFake()} loadCatalog={catalogOf(items())} start={vi.fn()} />);
    await screen.findByText("Credit Pack");
    expect(document.body.textContent).not.toMatch(/instant|unlimited|uptime|guarantee/i);
    expect(item("Credit Pack")).toBeInTheDocument();
  });
});
