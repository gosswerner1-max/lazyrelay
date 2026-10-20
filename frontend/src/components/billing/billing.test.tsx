import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BalanceIndicator } from "./BalanceIndicator";
import { BillingCard } from "./BillingCard";
import { ExpirationBanner } from "./ExpirationBanner";
import { MOCK_NOW, MOCK_SCENARIOS } from "../../dev/billingMockScenarios";

afterEach(cleanup);

const now = new Date(MOCK_NOW);
const lotsOf = (id: string) => MOCK_SCENARIOS.find((s) => s.id === id)!.lots;

describe("BalanceIndicator", () => {
  it("shows the compact text with a thousands separator and a green dot that says so in words", () => {
    render(<BalanceIndicator lots={lotsOf("healthy")} now={now} />);
    expect(screen.getByText("Available Balance: 2,030 Credits")).toBeInTheDocument();
    const dot = screen.getByRole("img", { name: "Balance is high" });
    expect(dot).toHaveAttribute("data-status", "high");
    expect(screen.queryByText("Low")).toBeNull();
    expect(screen.queryByText("Critical")).toBeNull();
  });
  it("is orange with a visible Low mark from 21 to 99", () => {
    render(<BalanceIndicator lots={lotsOf("low")} now={now} />);
    expect(screen.getByRole("img", { name: "Balance is getting low" })).toHaveAttribute("data-status", "medium");
    expect(screen.getByText("Low")).toBeInTheDocument();
  });
  it("is red with a visible Critical mark at 20 or under, and 0 for an empty wallet", () => {
    const { unmount } = render(<BalanceIndicator lots={lotsOf("critical")} now={now} />);
    expect(screen.getByRole("img", { name: "Balance is critically low" })).toHaveAttribute("data-status", "low");
    expect(screen.getByText("Critical")).toBeInTheDocument();
    unmount();
    render(<BalanceIndicator lots={[]} now={now} />);
    expect(screen.getByText("Available Balance: 0 Credits")).toBeInTheDocument();
  });
});

describe("ExpirationBanner", () => {
  it("renders nothing without an expiring lot", () => {
    const { container } = render(<ExpirationBanner lots={lotsOf("healthy")} now={now} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("renders nothing at 12 days", () => {
    const { container } = render(<ExpirationBanner lots={lotsOf("cancelled")} now={now} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("says the plan credits expire, as a status, and can be dismissed", async () => {
    render(<ExpirationBanner lots={lotsOf("expiring")} now={now} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Your Pro Plan credits expire in 3 days (2026-10-23). Unused plan credits do not roll over.");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("does not use browser storage to remember the dismissal", async () => {
    const before = localStorage.length + sessionStorage.length;
    render(<ExpirationBanner lots={lotsOf("expiring")} now={now} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(localStorage.length + sessionStorage.length).toBe(before);
  });
});

describe("BillingCard", () => {
  it("puts the total first, then the grid, and shows one primary button", () => {
    render(<BillingCard lots={lotsOf("healthy")} now={now} />);
    expect(screen.getByText("Total available balance")).toBeInTheDocument();
    expect(screen.getByTestId("billing-total")).toHaveTextContent("2,030");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    const total = screen.getByText("Total available balance");
    const grid = screen.getByTestId("billing-grid");
    expect(total.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("starts nothing: the button only shows the not-switched-on note", async () => {
    render(<BillingCard lots={lotsOf("healthy")} now={now} />);
    expect(screen.queryByText("Billing is not switched on yet.")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Buy Credits / Upgrade Plan" }));
    expect(screen.getByRole("status")).toHaveTextContent("Billing is not switched on yet.");
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("separates the three lots with the exact wording", () => {
    render(<BillingCard lots={lotsOf("healthy")} now={now} />);
    const plan = screen.getByRole("region", { name: "Subscription Plan" });
    expect(within(plan).getByText("1,200 credits")).toBeInTheDocument();
    expect(within(plan).getByText("Resets in 21 days on 2026-11-10")).toBeInTheDocument();
    expect(within(plan).getByText("Unused plan credits do not roll over.")).toBeInTheDocument();
    const topup = screen.getByRole("region", { name: "Pro Top-Up Pack" });
    expect(within(topup).getByText("500 credits")).toBeInTheDocument();
    expect(within(topup).getByText("Linked to active Pro Plan. Lapses in 21 days.")).toBeInTheDocument();
    const payg = screen.getByRole("region", { name: "Pay-As-You-Go" });
    expect(within(payg).getByText("330 credits")).toBeInTheDocument();
    expect(within(payg).getByText("Never Expires")).toBeInTheDocument();
    expect(within(payg).getByText("includes 30 free sign-up credits")).toBeInTheDocument();
  });
  it("says Ends in for a cancelled plan and adds the date to the top-up line", () => {
    render(<BillingCard lots={lotsOf("cancelled")} now={now} />);
    expect(screen.getByText("Ends in 12 days on 2026-11-01")).toBeInTheDocument();
    expect(screen.getByText("Linked to active Pro Plan. Lapses in 12 days on 2026-11-01.")).toBeInTheDocument();
  });
  it("leaves the top-up block out when there is no top-up, and shows None for no plan", () => {
    render(<BillingCard lots={lotsOf("payg")} now={now} />);
    expect(screen.queryByRole("region", { name: "Pro Top-Up Pack" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Subscription Plan" })).getByText("None")).toBeInTheDocument();
    expect(screen.queryByText(/free sign-up credits/)).toBeNull();
  });
  it("shows honest zeros for an empty wallet", () => {
    render(<BillingCard lots={[]} now={now} />);
    expect(screen.getByTestId("billing-total")).toHaveTextContent("0");
    expect(within(screen.getByRole("region", { name: "Pay-As-You-Go" })).getByText("0 credits")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Pay-As-You-Go" })).getByText("Never Expires")).toBeInTheDocument();
  });
  it("shows a free account as 30 free sign-up credits", () => {
    render(<BillingCard lots={lotsOf("free")} now={now} />);
    expect(screen.getByText("includes 30 free sign-up credits")).toBeInTheDocument();
  });
});
