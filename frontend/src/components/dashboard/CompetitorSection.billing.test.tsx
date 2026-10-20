import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The section reads VITE_BILLING_ENABLED once, when it loads. Each test sets the setting, loads a fresh copy of the section,
// and uses fake clients: no network is touched. The engine client and the billing client are told apart by who gets called.

const engine = vi.fn();
const billing = vi.fn();
const makeBillingClient = vi.fn(() => ({ blueprint: billing }));

const answer = {
  kind: "page" as const,
  sourceUrl: "https://rival.example/pricing",
  title: "Rival pricing page",
  blueprint: {
    hook: { type: "question" as const, note: "It asks a question." },
    sections: [{ order: 1, role: "Problem", summary: "Names the pain." }],
    cta: { placement: "top" as const, style: "A banner", count: 1 },
    adjustments: ["Open with a question too."],
  },
  creditsUsed: 10,
  balance: 77,
};

async function load(flag: string | undefined) {
  vi.resetModules();
  if (flag === undefined) vi.unstubAllEnvs();
  else vi.stubEnv("VITE_BILLING_ENABLED", flag);
  vi.doMock("../../lib/competitorDefault", () => ({ defaultCompetitorClient: { blueprint: engine } }));
  vi.doMock("../../lib/competitorBillingDefault", () => ({ defaultBillingClient: makeBillingClient }));
  return (await import("./CompetitorSection")).default;
}

beforeEach(() => {
  engine.mockResolvedValue(answer);
  billing.mockResolvedValue(answer);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function openDialog() {
  await userEvent.type(screen.getByLabelText("Paste a competitor link or website"), "https://rival.example/pricing");
  await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
  return screen.findByRole("dialog");
}

async function analyze() {
  const dialog = await openDialog();
  await userEvent.click(within(dialog).getByRole("checkbox"));
  await userEvent.click(within(dialog).getByRole("button", { name: /analyze this link/i }));
}

describe("with VITE_BILLING_ENABLED set to true", () => {
  it("calls the billing client with a key and never the engine client", async () => {
    const Section = await load("true");
    render(<Section />);
    await analyze();
    expect(await screen.findByRole("heading", { name: "Competitor structure" })).toBeInTheDocument();
    expect(billing).toHaveBeenCalledTimes(1);
    expect(billing).toHaveBeenCalledWith("https://rival.example/pricing", expect.any(AbortSignal), expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(engine).not.toHaveBeenCalled();
  });

  it("shows the cost line and the balance in the notice, and passes the parent's callbacks through", async () => {
    const Section = await load("true");
    const onAddCredits = vi.fn();
    const onBalanceChanged = vi.fn();
    render(<Section creditBalance={25} onAddCredits={onAddCredits} onBalanceChanged={onBalanceChanged} />);
    const dialog = await openDialog();
    expect(within(dialog).getByText("This costs 10 credits when a blueprint is delivered. You are not charged if it fails.")).toBeInTheDocument();
    expect(within(dialog).getByText("Your balance: 25 credits.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: /analyze this link/i }));
    await waitFor(() => expect(onBalanceChanged).toHaveBeenCalledWith(77));
  });
});

describe("with the setting unset or not exactly true", () => {
  it.each([undefined, "", "false", "TRUE", "1"])("(%j) calls the engine client with the link and signal only, and never builds the billing client", async (flag) => {
    const Section = await load(flag);
    render(<Section />);
    await analyze();
    expect(await screen.findByRole("heading", { name: "Competitor structure" })).toBeInTheDocument();
    expect(engine).toHaveBeenCalledWith("https://rival.example/pricing", expect.any(AbortSignal));
    expect(engine.mock.calls[0]).toHaveLength(2);
    expect(makeBillingClient).not.toHaveBeenCalled();
    expect(billing).not.toHaveBeenCalled();
  });

  it("shows no cost line, no balance and no Add credits button", async () => {
    const Section = await load(undefined);
    render(<Section creditBalance={25} onAddCredits={vi.fn()} />);
    const dialog = await openDialog();
    expect(dialog.textContent).not.toMatch(/credits/i);
    expect(screen.queryByRole("button", { name: "Add credits" })).toBeNull();
  });
});
