import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompetitorPanel } from "./CompetitorPanel";
import { CONSENT_TEXT, CompetitorError, type CompetitorClient } from "../../lib/competitorMode";
import type { CompetitorBlueprint } from "../../lib/competitorBlueprint";
import { COST_NOTICE, insufficientCreditsMessage, type BillingUi } from "../../lib/competitorBilling";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const answer: CompetitorBlueprint = {
  kind: "page",
  sourceUrl: "https://rival.example/pricing",
  title: "Rival pricing page",
  blueprint: {
    hook: { type: "statistic", note: "It opens with a number." },
    sections: [{ order: 1, role: "Problem", summary: "Names the pain." }],
    cta: { placement: "bottom", style: "One button", count: 1 },
    adjustments: ["Open with a number too."],
  },
  creditsUsed: 10,
  balance: 90,
};

function ui() {
  let n = 0;
  const newKey = vi.fn(() => `key-${++n}`);
  const billing: BillingUi = { newKey, costNotice: COST_NOTICE, balanceNotice: (b) => `Your balance: ${b} credits.`, addCreditsLabel: "Add credits" };
  return { billing, newKey };
}

type Calls = Array<[string, AbortSignal | undefined, string | undefined]>;
function setup(props: { client?: CompetitorClient; withBilling?: boolean; creditBalance?: number; onAddCredits?: () => void; onBalanceChanged?: (b: number) => void } = {}) {
  const blueprint = vi.fn(async (_i: string, _s?: AbortSignal, _k?: string) => answer);
  const client = props.client ?? { blueprint };
  const { billing, newKey } = ui();
  render(
    <CompetitorPanel
      client={client}
      billing={props.withBilling === false ? undefined : billing}
      creditBalance={props.creditBalance}
      onAddCredits={props.onAddCredits}
      onBalanceChanged={props.onBalanceChanged}
    />,
  );
  return { blueprint: client.blueprint as ReturnType<typeof vi.fn>, newKey };
}

const box = () => screen.getByLabelText("Paste a competitor link or website");

async function openDialog(link: string) {
  await userEvent.clear(box());
  await userEvent.type(box(), link);
  await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
  return screen.findByRole("dialog");
}

async function confirm(link = "https://rival.example/pricing") {
  const dialog = await openDialog(link);
  await userEvent.click(within(dialog).getByRole("checkbox"));
  await userEvent.click(within(dialog).getByRole("button", { name: /analyze this link/i }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("the idempotency key", () => {
  it("is made once when the person confirms, and handed to the client with the link", async () => {
    const { blueprint, newKey } = setup();
    expect(newKey).not.toHaveBeenCalled();
    await openDialog("https://rival.example/pricing");
    expect(newKey).not.toHaveBeenCalled(); // opening the notice makes nothing
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("checkbox"));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /analyze this link/i }));
    await screen.findByRole("heading", { name: "Competitor structure" });
    expect(newKey).toHaveBeenCalledTimes(1);
    expect(blueprint).toHaveBeenCalledTimes(1);
    const [input, signal, key] = (blueprint.mock.calls as Calls)[0]!;
    expect(input).toBe("https://rival.example/pricing");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(key).toBe("key-1");
  });

  it("is reused by the automatic retry after a dropped connection, and the person sees the result", async () => {
    const blueprint = vi.fn<CompetitorClient["blueprint"]>().mockRejectedValueOnce(new CompetitorError("network")).mockResolvedValue(answer);
    const { newKey } = setup({ client: { blueprint } });
    await confirm();
    await screen.findByRole("heading", { name: "Competitor structure" }, { timeout: 4000 });
    expect(blueprint).toHaveBeenCalledTimes(2);
    expect((blueprint.mock.calls as Calls).map((c) => c[2])).toEqual(["key-1", "key-1"]);
    expect(newKey).toHaveBeenCalledTimes(1);
  });

  it("retries once only, then shows the plain network line", async () => {
    const blueprint = vi.fn<CompetitorClient["blueprint"]>().mockRejectedValue(new CompetitorError("network"));
    setup({ client: { blueprint } });
    await confirm();
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent(/could not reach the service/i);
    expect(blueprint).toHaveBeenCalledTimes(2);
  });

  it("does not retry a refusal such as not enough credits", async () => {
    const blueprint = vi.fn<CompetitorClient["blueprint"]>().mockRejectedValue(new CompetitorError("insufficient_credits", insufficientCreditsMessage(3)));
    setup({ client: { blueprint } });
    await confirm();
    await screen.findByRole("alert");
    expect(blueprint).toHaveBeenCalledTimes(1);
  });

  it("is a new one when the person confirms a second time", async () => {
    const { blueprint, newKey } = setup();
    await confirm("https://rival.example/pricing");
    await screen.findByRole("heading", { name: "Competitor structure" });
    await confirm("https://rival.example/pricing");
    await waitFor(() => expect(blueprint).toHaveBeenCalledTimes(2));
    expect((blueprint.mock.calls as Calls).map((c) => c[2])).toEqual(["key-1", "key-2"]);
    expect(newKey).toHaveBeenCalledTimes(2);
  });
});

describe("without the credits setting", () => {
  it("calls the client with the link and the signal only, makes no key, and shows no credits words", async () => {
    const { blueprint } = setup({ withBilling: false, creditBalance: 40 });
    await confirm();
    await screen.findByRole("heading", { name: "Competitor structure" });
    expect(blueprint).toHaveBeenCalledWith("https://rival.example/pricing", expect.any(AbortSignal));
    expect((blueprint.mock.calls[0] as unknown[]).length).toBe(2);
  });

  it("does not retry a dropped connection", async () => {
    const blueprint = vi.fn<CompetitorClient["blueprint"]>().mockRejectedValue(new CompetitorError("network"));
    setup({ client: { blueprint }, withBilling: false });
    await confirm();
    await screen.findByRole("alert");
    expect(blueprint).toHaveBeenCalledTimes(1);
  });

  it("shows no cost line and no balance in the notice", async () => {
    setup({ withBilling: false, creditBalance: 40 });
    const dialog = await openDialog("https://rival.example/pricing");
    expect(dialog.textContent).not.toMatch(/credits/i);
    expect(within(dialog).getByText(CONSENT_TEXT)).toBeInTheDocument();
  });
});

describe("the notice with the credits setting", () => {
  it("says what it costs above the tick box, keeps the consent sentence exactly, and shows the balance when it is known", async () => {
    setup({ creditBalance: 40 });
    const dialog = await openDialog("https://rival.example/pricing");
    const cost = within(dialog).getByText("This costs 10 credits when a blueprint is delivered. You are not charged if it fails.");
    const balance = within(dialog).getByText("Your balance: 40 credits.");
    const consent = within(dialog).getByText(CONSENT_TEXT);
    const tick = within(dialog).getByRole("checkbox");
    expect(CONSENT_TEXT).toBe("AI can make mistakes. I confirm this tool is used for public market analysis and research purposes.");
    // document order: cost line, balance line, then the tick box with its sentence
    expect(cost.compareDocumentPosition(balance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(balance.compareDocumentPosition(tick) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(consent).toBeInTheDocument();
  });

  it("leaves the balance line out when no balance is supplied", async () => {
    setup();
    const dialog = await openDialog("https://rival.example/pricing");
    expect(within(dialog).getByText(COST_NOTICE)).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/your balance/i);
  });

  it("has no em or en dash and none of the claims we cannot prove", async () => {
    setup({ creditBalance: 40 });
    const dialog = await openDialog("https://rival.example/pricing");
    expect(dialog.textContent).not.toMatch(/[–—]/);
    expect(dialog.textContent).not.toMatch(/\b(free|instant(ly)?|guarantee[ds]?)\b/i);
  });
});

describe("not enough credits", () => {
  const blueprint = () => vi.fn<CompetitorClient["blueprint"]>().mockRejectedValue(new CompetitorError("insufficient_credits", insufficientCreditsMessage(3)));

  it("shows the message and an Add credits button that calls the parent", async () => {
    const onAddCredits = vi.fn();
    setup({ client: { blueprint: blueprint() }, onAddCredits });
    await confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent("You need 10 credits for a competitor teardown. You have 3.");
    await userEvent.click(screen.getByRole("button", { name: "Add credits" }));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
  });

  it("hides the button when the parent gave no way to add credits", async () => {
    setup({ client: { blueprint: blueprint() } });
    await confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent("You need 10 credits");
    expect(screen.queryByRole("button", { name: "Add credits" })).toBeNull();
  });

  it("shows the button for no other error", async () => {
    const other = vi.fn<CompetitorClient["blueprint"]>().mockRejectedValue(new CompetitorError("in_flight", "A teardown is already running. Please wait for it to finish."));
    setup({ client: { blueprint: other }, onAddCredits: vi.fn() });
    await confirm();
    expect(await screen.findByRole("alert")).toHaveTextContent("A teardown is already running");
    expect(screen.queryByRole("button", { name: "Add credits" })).toBeNull();
  });
});

describe("the balance after a run", () => {
  it("tells the parent the new balance once the blueprint is shown", async () => {
    const onBalanceChanged = vi.fn();
    setup({ onBalanceChanged });
    await confirm();
    await screen.findByRole("heading", { name: "Competitor structure" });
    expect(onBalanceChanged).toHaveBeenCalledTimes(1);
    expect(onBalanceChanged).toHaveBeenCalledWith(90);
  });

  it("does not call it on a failure, and does nothing when the parent gave none", async () => {
    const onBalanceChanged = vi.fn();
    const failing = vi.fn<CompetitorClient["blueprint"]>().mockRejectedValue(new CompetitorError("in_flight", "A teardown is already running. Please wait for it to finish."));
    setup({ client: { blueprint: failing }, onBalanceChanged });
    await confirm();
    await screen.findByRole("alert");
    expect(onBalanceChanged).not.toHaveBeenCalled();
    cleanup();
    setup();
    await confirm();
    await screen.findByRole("heading", { name: "Competitor structure" });
  });
});
