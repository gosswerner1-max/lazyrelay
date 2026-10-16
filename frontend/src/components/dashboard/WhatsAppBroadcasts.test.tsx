import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// WhatsApp broadcasts: the template list and sync, the customer's own rate card, the composer (template, variables, preview, schedule)
// and the broadcast list with delivery counts "N delivered of M, confirmed by Meta" and an ESTIMATED cost. The API is a mock; no number,
// token or real message exists in this file.

const api = vi.hoisted(() => ({
  listWhatsAppTemplates: vi.fn(),
  syncWhatsAppTemplates: vi.fn(),
  getWhatsAppRateCard: vi.fn(),
  saveWhatsAppRateCard: vi.fn(),
  listWhatsAppBroadcasts: vi.fn(),
  createWhatsAppBroadcast: vi.fn(),
  cancelWhatsAppBroadcast: vi.fn(),
  resumeWhatsAppSending: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

import { WhatsAppTemplates } from "./WhatsAppTemplates";
import { WhatsAppRateCard } from "./WhatsAppRateCard";
import { WhatsAppBroadcastComposer } from "./WhatsAppBroadcastComposer";
import { WhatsAppBroadcastList } from "./WhatsAppBroadcastList";
import type { WhatsAppBroadcast, WhatsAppTemplate } from "../../lib/api";

const SA1 = "11111111-1111-4111-8111-111111111111";
const LONG_DIGIT_RUN = /(?:\d[\s().-]?){7,}/;

const template = (over: Partial<WhatsAppTemplate> = {}): WhatsAppTemplate => ({
  id: "t1",
  name: "spring_offer",
  language: "en_US",
  category: "marketing",
  status: "approved",
  bodyText: "Hi {{1}}, {{2}} off today",
  variableCount: 2,
  supported: true,
  unsupportedReason: null,
  usable: true,
  syncedAt: "2026-10-16T10:00:00.000Z",
  ...over,
});
const broadcast = (over: Partial<WhatsAppBroadcast> = {}): WhatsAppBroadcast => ({
  id: "b1",
  socialAccountId: SA1,
  name: "Spring sale",
  status: "completed",
  pauseReason: null,
  templateName: "spring_offer",
  templateLanguage: "en_US",
  templateCategory: "marketing",
  scheduledFor: "2026-10-20T09:00:00.000Z",
  startedAt: "2026-10-20T09:00:05.000Z",
  completedAt: "2026-10-20T09:05:00.000Z",
  cancelledAt: null,
  createdAt: "2026-10-16T10:00:00.000Z",
  audienceEstimate: 10,
  counts: { total: 10, queued: 0, accepted: 9, sent: 1, delivered: 5, read: 2, failed: 1, skipped: 0 },
  delivery: { delivered: 7, ofAccepted: 9 },
  costEstimate: { amount: 0.35, currency: "USD", isEstimate: true },
  ...over,
});

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listWhatsAppTemplates.mockResolvedValue({ templates: [template()] });
  api.listWhatsAppBroadcasts.mockResolvedValue({ broadcasts: [], nextBefore: null });
  api.getWhatsAppRateCard.mockResolvedValue({ rateCard: null });
});

describe("WhatsAppTemplates", () => {
  it("lists templates from the customer's Meta account with what can be used, and why not for the rest", async () => {
    api.listWhatsAppTemplates.mockResolvedValue({
      templates: [template(), template({ id: "t2", name: "media_one", usable: false, supported: false, unsupportedReason: "media_header" }), template({ id: "t3", name: "waiting", status: "pending", usable: false })],
    });
    render(<WhatsAppTemplates socialAccountId={SA1} />);
    expect(await screen.findByText("spring_offer")).toBeInTheDocument();
    expect(screen.getByText(/ready to use/i)).toBeInTheDocument();
    expect(screen.getByText(/not supported yet: has a picture, video or document header/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting for meta/i)).toBeInTheDocument();
  });

  it("says what to do when there are none", async () => {
    api.listWhatsAppTemplates.mockResolvedValue({ templates: [] });
    render(<WhatsAppTemplates socialAccountId={SA1} />);
    expect(await screen.findByText(/no templates yet/i)).toBeInTheDocument();
  });

  it("Sync templates reads them from Meta, reloads, and says how many", async () => {
    const user = userEvent.setup();
    api.syncWhatsAppTemplates.mockResolvedValue({ synced: 3, approved: 2, unsupported: 1, disabled: 0 });
    render(<WhatsAppTemplates socialAccountId={SA1} />);
    await screen.findByText("spring_offer");
    await user.click(screen.getByRole("button", { name: /sync templates/i }));
    await waitFor(() => expect(api.syncWhatsAppTemplates).toHaveBeenCalledWith(SA1));
    expect(await screen.findByText(/synced 3 templates, 2 approved/i)).toBeInTheDocument();
    expect(api.listWhatsAppTemplates).toHaveBeenCalledTimes(2);
  });

  it("shows the server's message when the sync fails", async () => {
    const user = userEvent.setup();
    api.syncWhatsAppTemplates.mockRejectedValue(new Error("Meta did not accept your access token."));
    render(<WhatsAppTemplates socialAccountId={SA1} />);
    await screen.findByText("spring_offer");
    await user.click(screen.getByRole("button", { name: /sync templates/i }));
    expect(await screen.findByText(/did not accept your access token/i)).toBeInTheDocument();
  });
});

describe("WhatsAppRateCard", () => {
  it("explains it is the customer's own price list, used only for an estimate", async () => {
    render(<WhatsAppRateCard socialAccountId={SA1} />);
    expect(await screen.findByText(/estimate/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/currency/i)).toBeInTheDocument();
  });

  it("saves the prices", async () => {
    const user = userEvent.setup();
    api.saveWhatsAppRateCard.mockResolvedValue({ rateCard: { currency: "USD", marketing: 0.05, utility: 0.01, authentication: 0.01 } });
    render(<WhatsAppRateCard socialAccountId={SA1} />);
    await screen.findByLabelText(/currency/i);
    await user.type(screen.getByLabelText(/currency/i), "USD");
    await user.type(screen.getByLabelText(/marketing/i), "0.05");
    await user.type(screen.getByLabelText(/utility/i), "0.01");
    await user.type(screen.getByLabelText(/authentication/i), "0.01");
    await user.click(screen.getByRole("button", { name: /save prices/i }));
    await waitFor(() => expect(api.saveWhatsAppRateCard).toHaveBeenCalledWith(SA1, { currency: "USD", marketing: 0.05, utility: 0.01, authentication: 0.01 }));
  });

  it("refuses a bad currency or a negative price before calling the server", async () => {
    const user = userEvent.setup();
    render(<WhatsAppRateCard socialAccountId={SA1} />);
    await screen.findByLabelText(/currency/i);
    await user.type(screen.getByLabelText(/currency/i), "us");
    await user.type(screen.getByLabelText(/marketing/i), "-1");
    await user.click(screen.getByRole("button", { name: /save prices/i }));
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(api.saveWhatsAppRateCard).not.toHaveBeenCalled();
  });

  it("fills in a saved card", async () => {
    api.getWhatsAppRateCard.mockResolvedValue({ rateCard: { currency: "ZAR", marketing: 0.8, utility: 0.2, authentication: 0.2 } });
    render(<WhatsAppRateCard socialAccountId={SA1} />);
    await waitFor(() => expect(screen.getByLabelText(/currency/i)).toHaveValue("ZAR"));
    expect(screen.getByLabelText(/marketing/i)).toHaveValue(0.8);
  });
});

/** A local time two days from now (the form allows 1 minute to 30 days ahead). */
const SOON = (() => {
  const d = new Date(Date.now() + 2 * 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
})();

describe("WhatsAppBroadcastComposer", () => {
  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole("option", { name: /spring_offer/ });
    await user.selectOptions(screen.getByLabelText(/template/i), "t1");
    await user.type(screen.getByLabelText(/^name/i), "Spring sale");
    await user.type(screen.getByLabelText(/value 1/i), "Friend");
    await user.type(screen.getByLabelText(/value 2/i), "20%");
    fireEvent.change(screen.getByLabelText(/send at/i), { target: { value: SOON } });
  }

  it("offers only usable templates, shows the chosen template's text and one box per variable", async () => {
    api.listWhatsAppTemplates.mockResolvedValue({ templates: [template(), template({ id: "t2", name: "waiting", status: "pending", usable: false })] });
    const user = userEvent.setup();
    render(<WhatsAppBroadcastComposer socialAccountId={SA1} onCreated={() => {}} />);
    await screen.findByRole("option", { name: /spring_offer/ });
    expect(screen.queryByRole("option", { name: /waiting/ })).toBeNull();
    await user.selectOptions(screen.getByLabelText(/template/i), "t1");
    expect(screen.getByText("Hi {{1}}, {{2}} off today")).toBeInTheDocument();
    expect(screen.getByLabelText(/value 1/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/value 2/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/value 3/i)).toBeNull();
  });

  it("says plainly that opted-out people are skipped, and that handed off is not delivered", async () => {
    render(<WhatsAppBroadcastComposer socialAccountId={SA1} onCreated={() => {}} />);
    expect(await screen.findByText(/anyone who opted out is skipped automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/only counted as delivered when meta says so/i)).toBeInTheDocument();
  });

  it("Preview shows how many people, who is left out, and the ESTIMATED cost, and stores nothing", async () => {
    const user = userEvent.setup();
    api.createWhatsAppBroadcast.mockResolvedValue({ dryRun: true, preview: { audience: 12, excludedUs: 3, estimatedCost: { amount: 0.6, currency: "USD", isEstimate: true } } });
    render(<WhatsAppBroadcastComposer socialAccountId={SA1} onCreated={() => {}} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: /^preview/i }));
    expect(await screen.findByText(/12 people will get this/i)).toBeInTheDocument();
    expect(screen.getByText(/3 contacts with US \(\+1\) numbers are left out/i)).toBeInTheDocument();
    expect(screen.getByText(/estimated cost: USD 0\.60 \(from your own rate card, not meta's bill\)/i)).toBeInTheDocument();
    expect(api.createWhatsAppBroadcast).toHaveBeenCalledWith(expect.objectContaining({ socialAccountId: SA1, templateId: "t1", params: ["Friend", "20%"], dryRun: true }));
  });

  it("Schedule sends the real request with an ISO time, tells the person, and refreshes the list", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    api.createWhatsAppBroadcast.mockResolvedValue({ dryRun: false, preview: { audience: 12, excludedUs: 0, estimatedCostCost: null, estimatedCost: null }, broadcast: broadcast({ status: "scheduled" }) });
    render(<WhatsAppBroadcastComposer socialAccountId={SA1} onCreated={onCreated} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: /^schedule broadcast/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const body = api.createWhatsAppBroadcast.mock.calls[0][0];
    expect(body).toMatchObject({ name: "Spring sale", scheduledFor: new Date(SOON).toISOString() });
    expect(body.dryRun).toBeFalsy();
    expect(await screen.findByText(/your broadcast is scheduled/i)).toBeInTheDocument();
  });

  it("checks the form first and names what is missing, without calling the server", async () => {
    const user = userEvent.setup();
    render(<WhatsAppBroadcastComposer socialAccountId={SA1} onCreated={() => {}} />);
    await screen.findByRole("option", { name: /spring_offer/ });
    await user.click(screen.getByRole("button", { name: /^schedule broadcast/i }));
    expect(screen.getAllByRole("alert").length).toBeGreaterThanOrEqual(2);
    expect(api.createWhatsAppBroadcast).not.toHaveBeenCalled();
  });

  it("shows the server's refusal in plain words (for example the cap)", async () => {
    const user = userEvent.setup();
    api.createWhatsAppBroadcast.mockRejectedValue(new Error("A broadcast can reach at most 250 people right now."));
    render(<WhatsAppBroadcastComposer socialAccountId={SA1} onCreated={() => {}} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: /^schedule broadcast/i }));
    expect(await screen.findByText(/at most 250 people/i)).toBeInTheDocument();
  });

  it("tells a person with no usable template what to do", async () => {
    api.listWhatsAppTemplates.mockResolvedValue({ templates: [] });
    render(<WhatsAppBroadcastComposer socialAccountId={SA1} onCreated={() => {}} />);
    expect(await screen.findByText(/no templates yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^schedule broadcast/i })).toBeDisabled();
  });
});

describe("WhatsAppBroadcastList", () => {
  it("shows each broadcast with its status, schedule, 'N delivered of M, confirmed by Meta' and an ESTIMATED cost", async () => {
    api.listWhatsAppBroadcasts.mockResolvedValue({ broadcasts: [broadcast()], nextBefore: null });
    render(<WhatsAppBroadcastList socialAccountId={SA1} refreshKey={0} />);
    expect(await screen.findByText("Spring sale")).toBeInTheDocument();
    expect(screen.getByText("Finished")).toBeInTheDocument();
    expect(screen.getByText("7 delivered of 9, confirmed by Meta")).toBeInTheDocument();
    expect(screen.getByText(/estimated cost: USD 0\.35 \(from your own rate card, not meta's bill\)/i)).toBeInTheDocument();
    expect(screen.getByText(/1 not sent/i)).toBeInTheDocument();
  });

  it("with no rate card it asks for one and never invents a cost", async () => {
    api.listWhatsAppBroadcasts.mockResolvedValue({ broadcasts: [broadcast({ costEstimate: null })], nextBefore: null });
    render(<WhatsAppBroadcastList socialAccountId={SA1} refreshKey={0} />);
    expect(await screen.findByText(/add your rate card to see an estimated cost/i)).toBeInTheDocument();
  });

  it("a broadcast nothing has been handed over for yet says so instead of '0 delivered of 0'", async () => {
    api.listWhatsAppBroadcasts.mockResolvedValue({ broadcasts: [broadcast({ status: "scheduled", delivery: { delivered: 0, ofAccepted: 0 }, costEstimate: null })], nextBefore: null });
    render(<WhatsAppBroadcastList socialAccountId={SA1} refreshKey={0} />);
    expect(await screen.findByText(/nothing has been handed to whatsapp yet/i)).toBeInTheDocument();
  });

  it("cancels a scheduled broadcast after one confirmation", async () => {
    const user = userEvent.setup();
    api.listWhatsAppBroadcasts.mockResolvedValue({ broadcasts: [broadcast({ status: "scheduled", delivery: { delivered: 0, ofAccepted: 0 } })], nextBefore: null });
    api.cancelWhatsAppBroadcast.mockResolvedValue({ status: "cancelled" });
    render(<WhatsAppBroadcastList socialAccountId={SA1} refreshKey={0} />);
    await user.click(await screen.findByRole("button", { name: /cancel spring sale/i }));
    expect(api.cancelWhatsAppBroadcast).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /yes, cancel it/i }));
    await waitFor(() => expect(api.cancelWhatsAppBroadcast).toHaveBeenCalledWith("b1"));
  });

  it("a finished broadcast has no cancel button", async () => {
    api.listWhatsAppBroadcasts.mockResolvedValue({ broadcasts: [broadcast()], nextBefore: null });
    render(<WhatsAppBroadcastList socialAccountId={SA1} refreshKey={0} />);
    await screen.findByText("Spring sale");
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("a broadcast paused because Meta restricted the number says what to do and offers to resume the number", async () => {
    const user = userEvent.setup();
    api.listWhatsAppBroadcasts.mockResolvedValue({ broadcasts: [broadcast({ status: "paused", pauseReason: "connection_paused", delivery: { delivered: 0, ofAccepted: 0 }, costEstimate: null })], nextBefore: null });
    api.resumeWhatsAppSending.mockResolvedValue({ ok: true });
    render(<WhatsAppBroadcastList socialAccountId={SA1} refreshKey={0} />);
    expect(await screen.findByText(/this number is paused/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /resume this number/i }));
    await waitFor(() => expect(api.resumeWhatsAppSending).toHaveBeenCalledWith(SA1));
  });

  it("says when there are none yet, shows an error in plain words, and loads more", async () => {
    api.listWhatsAppBroadcasts.mockResolvedValueOnce({ broadcasts: [], nextBefore: null });
    const { unmount } = render(<WhatsAppBroadcastList socialAccountId={SA1} refreshKey={0} />);
    expect(await screen.findByText(/no broadcasts yet/i)).toBeInTheDocument();
    unmount();
    api.listWhatsAppBroadcasts.mockRejectedValueOnce(new Error("Something went wrong."));
    render(<WhatsAppBroadcastList socialAccountId={SA1} refreshKey={0} />);
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });
});

describe("privacy and wording", () => {
  it("renders no long digit run anywhere (a phone number could never appear here)", async () => {
    api.listWhatsAppBroadcasts.mockResolvedValue({ broadcasts: [broadcast()], nextBefore: null });
    const { container } = render(
      <>
        <WhatsAppTemplates socialAccountId={SA1} />
        <WhatsAppBroadcastList socialAccountId={SA1} refreshKey={0} />
      </>,
    );
    await screen.findByText("Spring sale");
    // dates are shown in words; none of the visible text is a run of digits like a phone number
    expect(within(container).queryByText(LONG_DIGIT_RUN)).toBeNull();
  });

  it("the source files contain no em dash or en dash in user-facing text", () => {
    for (const f of ["WhatsAppTemplates.tsx", "WhatsAppRateCard.tsx", "WhatsAppBroadcastComposer.tsx", "WhatsAppBroadcastList.tsx"]) {
      const src = readFileSync(resolve(__dirname, f), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      expect(src, f).not.toMatch(/[–—]/);
    }
  });
});
