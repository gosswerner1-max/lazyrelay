import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// WhatsApp contacts and consent screens (Phase 1: nothing is sent). The API is a mock and no real phone number exists anywhere
// in this file other than the made-up ones typed into the forms.

const api = vi.hoisted(() => ({
  addWhatsAppContact: vi.fn(),
  importWhatsAppContacts: vi.fn(),
  listWhatsAppContacts: vi.fn(),
  optOutWhatsAppContact: vi.fn(),
  eraseWhatsAppContact: vi.fn(),
  listWhatsAppOptOuts: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ api }));

import { WhatsAppOptInForm } from "./WhatsAppOptInForm";
import { WhatsAppContactImport } from "./WhatsAppContactImport";
import { WhatsAppContactList, WhatsAppOptOuts } from "./WhatsAppContactList";
import { ATTESTATION_TEXT } from "../../lib/whatsappContacts";
import type { WhatsAppContact } from "../../lib/api";

const SA1 = "11111111-1111-4111-8111-111111111111";
const LONG_DIGIT_RUN = /(?:\d[\s().-]?){7,}/;

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

const contact = (over: Partial<WhatsAppContact> = {}): WhatsAppContact => ({
  id: "c1",
  socialAccountId: SA1,
  contactKey: "a".repeat(64),
  contactDisplay: "+27 ** *** 1111",
  displayName: "Thandi",
  countryCallingCode: "27",
  consentStatus: "opted_in",
  optedInAt: "2026-10-01T00:00:00.000Z",
  optedOutAt: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  ...over,
});

describe("WhatsAppOptInForm", () => {
  async function fillAllButAttestation(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/phone number/i), "+27 82 123 4567");
    await user.type(screen.getByLabelText(/^name/i), "Thandi");
    await user.selectOptions(screen.getByLabelText(/where did the consent come from/i), "website_form");
    await user.type(screen.getByLabelText(/date they gave consent/i), "2026-10-01");
    await user.type(screen.getByLabelText(/what did they agree to/i), "I agree to get offers on WhatsApp");
  }

  it("shows the attestation wording and every required field, with the source blank until chosen", () => {
    render(<WhatsAppOptInForm socialAccountId={SA1} onAdded={() => {}} />);
    expect(screen.getByLabelText(/where did the consent come from/i)).toHaveValue("");
    expect(screen.getByLabelText(/proof reference/i)).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: /i confirm that/i });
    expect(box).not.toBeChecked();
    expect(screen.getByText(ATTESTATION_TEXT)).toBeInTheDocument();
  });

  it("refuses to submit without the attestation tick and says why", async () => {
    const user = userEvent.setup();
    render(<WhatsAppOptInForm socialAccountId={SA1} onAdded={() => {}} />);
    await fillAllButAttestation(user);
    await user.click(screen.getByRole("button", { name: /add contact/i }));
    expect(api.addWhatsAppContact).not.toHaveBeenCalled();
    expect(screen.getByText(/tick the box to confirm/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /i confirm that/i })).toHaveAttribute("aria-invalid", "true");
  });

  it("refuses an empty form, a missing source, a future date and a bad number, without calling the API", async () => {
    const user = userEvent.setup();
    render(<WhatsAppOptInForm socialAccountId={SA1} onAdded={() => {}} />);
    await user.click(screen.getByRole("checkbox", { name: /i confirm that/i }));
    await user.click(screen.getByRole("button", { name: /add contact/i }));
    expect(api.addWhatsAppContact).not.toHaveBeenCalled();
    expect(screen.getByText(/choose where the consent came from/i)).toBeInTheDocument();
    expect(screen.getByText(/enter the date they gave consent/i)).toBeInTheDocument();
    expect(screen.getByText(/enter the phone number with its country code/i)).toBeInTheDocument();
  });

  it("sends the contact with its consent record once everything is filled in and ticked", async () => {
    const user = userEvent.setup();
    const onAdded = vi.fn();
    api.addWhatsAppContact.mockResolvedValue({ status: "created" });
    render(<WhatsAppOptInForm socialAccountId={SA1} onAdded={onAdded} />);
    await fillAllButAttestation(user);
    await user.click(screen.getByRole("checkbox", { name: /i confirm that/i }));
    await user.click(screen.getByRole("button", { name: /add contact/i }));
    await waitFor(() => expect(api.addWhatsAppContact).toHaveBeenCalledTimes(1));
    expect(api.addWhatsAppContact).toHaveBeenCalledWith({
      socialAccountId: SA1,
      phone: "+27 82 123 4567",
      name: "Thandi",
      optIn: { source: "website_form", capturedAt: "2026-10-01", consentText: "I agree to get offers on WhatsApp", proofReference: "", attested: true },
    });
    expect(await screen.findByText(/contact added/i)).toBeInTheDocument();
    expect(onAdded).toHaveBeenCalled();
    // the number is cleared from the form once it is saved
    expect(screen.getByLabelText(/phone number/i)).toHaveValue("");
  });

  it("shows the server's refusal (for example an opted-out number) and keeps the form", async () => {
    const user = userEvent.setup();
    api.addWhatsAppContact.mockRejectedValue(new Error("This number has opted out and cannot be added."));
    render(<WhatsAppOptInForm socialAccountId={SA1} onAdded={() => {}} />);
    await fillAllButAttestation(user);
    await user.click(screen.getByRole("checkbox", { name: /i confirm that/i }));
    await user.click(screen.getByRole("button", { name: /add contact/i }));
    expect(await screen.findByText(/has opted out and cannot be added/i)).toBeInTheDocument();
  });

  it("marks the number and name inputs so session replay never records them", () => {
    render(<WhatsAppOptInForm socialAccountId={SA1} onAdded={() => {}} />);
    for (const label of [/phone number/i, /^name/i]) expect(screen.getByLabelText(label).closest(".ph-no-capture")).not.toBeNull();
  });
});

describe("WhatsAppContactList", () => {
  it("shows masks and names in words, never a run of seven or more digits, even if the server sent one", async () => {
    api.listWhatsAppContacts.mockResolvedValue({
      contacts: [
        contact(),
        contact({ id: "c2", contactDisplay: "+27 82 123 4567", displayName: "0821234567", consentStatus: "opted_out", optedOutAt: "2026-10-12T00:00:00.000Z" }),
        contact({ id: "c3", contactDisplay: "+44 ** *** 3333", displayName: null }),
      ],
      nextBefore: null,
    });
    const { container } = render(<WhatsAppContactList socialAccountId={SA1} refreshKey={0} />);
    expect(await screen.findByText(/\+27 \*\* \*\*\* 1111/)).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(LONG_DIGIT_RUN);
    expect(screen.getAllByText("Opted in").length).toBeGreaterThan(0);
    expect(screen.getByText("Opted out")).toBeInTheDocument();
    expect(container.querySelector(".ph-no-capture")).not.toBeNull();
  });

  it("asks the server with the chosen connection and filter", async () => {
    const user = userEvent.setup();
    api.listWhatsAppContacts.mockResolvedValue({ contacts: [], nextBefore: null });
    render(<WhatsAppContactList socialAccountId={SA1} refreshKey={0} />);
    await waitFor(() => expect(api.listWhatsAppContacts).toHaveBeenCalledWith(expect.objectContaining({ socialAccountId: SA1 })));
    await user.selectOptions(screen.getByLabelText(/show/i), "opted_out");
    await waitFor(() => expect(api.listWhatsAppContacts).toHaveBeenLastCalledWith(expect.objectContaining({ socialAccountId: SA1, status: "opted_out" })));
    expect(await screen.findByText(/no contacts yet/i)).toBeInTheDocument();
  });

  it("refuses a search that looks like a phone number before it reaches the URL", async () => {
    const user = userEvent.setup();
    api.listWhatsAppContacts.mockResolvedValue({ contacts: [], nextBefore: null });
    render(<WhatsAppContactList socialAccountId={SA1} refreshKey={0} />);
    await waitFor(() => expect(api.listWhatsAppContacts).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText(/search/i), "27821234567");
    await user.click(screen.getByRole("button", { name: /^search$/i }));
    expect(screen.getByText(/search by name or the last digits/i)).toBeInTheDocument();
    expect(api.listWhatsAppContacts).toHaveBeenCalledTimes(1);
  });

  it("opts a contact out, and erases only after an explicit second step", async () => {
    const user = userEvent.setup();
    api.listWhatsAppContacts.mockResolvedValue({ contacts: [contact()], nextBefore: null });
    api.optOutWhatsAppContact.mockResolvedValue({ ok: true });
    api.eraseWhatsAppContact.mockResolvedValue({ ok: true });
    render(<WhatsAppContactList socialAccountId={SA1} refreshKey={0} />);
    await screen.findByText(/\+27 \*\* \*\*\* 1111/);
    await user.click(screen.getByRole("button", { name: /mark thandi as opted out/i }));
    await waitFor(() => expect(api.optOutWhatsAppContact).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText("Opted out")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /erase thandi/i }));
    expect(api.eraseWhatsAppContact).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group", { name: /confirm erase/i });
    await user.click(within(confirm).getByRole("button", { name: /^erase$/i }));
    await waitFor(() => expect(api.eraseWhatsAppContact).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.queryByText(/\+27 \*\* \*\*\* 1111/)).toBeNull());
  });
});

describe("WhatsAppOptOuts", () => {
  it("shows the count and masked entries only", async () => {
    api.listWhatsAppOptOuts.mockResolvedValue({
      count: 2,
      optOuts: [
        { id: "o1", contactDisplay: "+27 ** *** 1111", scope: "all", source: "keyword", keyword: "STOP", occurredAt: "2026-10-12T10:00:00.000Z" },
        { id: "o2", contactDisplay: "+27 ** *** 2222", scope: "all", source: "manual", keyword: null, occurredAt: "2026-10-13T10:00:00.000Z" },
      ],
    });
    const { container } = render(<WhatsAppOptOuts refreshKey={0} />);
    expect(await screen.findByText(/2 numbers/i)).toBeInTheDocument();
    expect(screen.getByText(/\+27 \*\* \*\*\* 2222/)).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(LONG_DIGIT_RUN);
  });
});

describe("WhatsAppContactImport", () => {
  const csv = (text: string) => new File([text], "contacts.csv", { type: "text/csv" });

  async function pick(user: ReturnType<typeof userEvent.setup>, text: string) {
    await user.upload(screen.getByLabelText(/csv file/i), csv(text));
  }
  async function consent(user: ReturnType<typeof userEvent.setup>, tick = true) {
    await user.selectOptions(screen.getByLabelText(/where did the consent come from/i), "customer_import");
    await user.type(screen.getByLabelText(/date they gave consent/i), "2026-10-01");
    await user.type(screen.getByLabelText(/what did they agree to/i), "Ticked the WhatsApp offers box at checkout");
    if (tick) await user.click(screen.getByRole("checkbox", { name: /i confirm that/i }));
  }

  it("explains the mandatory opted_in column and refuses a file without it", async () => {
    const user = userEvent.setup();
    render(<WhatsAppContactImport socialAccountId={SA1} onImported={() => {}} />);
    expect(screen.getAllByText(/opted_in/).length).toBeGreaterThan(0);
    await pick(user, "phone,name\n+27821234567,Thandi\n");
    expect(await screen.findByText(/needs an opted_in column/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check the file/i })).toBeNull();
  });

  it("previews the file locally with masked numbers and the rows that will be skipped", async () => {
    const user = userEvent.setup();
    const { container } = render(<WhatsAppContactImport socialAccountId={SA1} onImported={() => {}} />);
    await pick(user, "phone,name,opted_in\n+27 82 123 4567,Thandi,yes\n+27 83 123 4567,Pieter,no\n0841234567,Sam,yes\n");
    expect(await screen.findByText(/3 contacts found/i)).toBeInTheDocument();
    expect(screen.getByText(/1 look ready/i)).toBeInTheDocument();
    expect(screen.getByText(/row 2/i)).toBeInTheDocument();
    expect(screen.getByText(/row 3/i)).toBeInTheDocument();
    expect(screen.getByText(/\+27 \*\* \*\*\* 4567/)).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(LONG_DIGIT_RUN);
    expect(api.importWhatsAppContacts).not.toHaveBeenCalled();
  });

  it("will not check or import without the consent details and the attestation tick", async () => {
    const user = userEvent.setup();
    render(<WhatsAppContactImport socialAccountId={SA1} onImported={() => {}} />);
    await pick(user, "phone,opted_in\n+27 82 123 4567,yes\n");
    await screen.findByText(/1 contact found/i);
    await consent(user, false);
    await user.click(screen.getByRole("button", { name: /check the file/i }));
    expect(api.importWhatsAppContacts).not.toHaveBeenCalled();
    expect(screen.getByText(/tick the box to confirm/i)).toBeInTheDocument();
  });

  it("checks first (dry run), then imports only after the check, and tells the server the consent details", async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    api.importWhatsAppContacts.mockImplementation(async (body: { dryRun: boolean }) => ({ dryRun: body.dryRun, accepted: 1, duplicates: 0, suppressed: 1, rejected: [] }));
    render(<WhatsAppContactImport socialAccountId={SA1} onImported={onImported} />);
    await pick(user, "phone,name,opted_in\n+27 82 123 4567,Thandi,yes\n+27 83 123 4567,Pieter,yes\n");
    await screen.findByText(/2 contacts found/i);
    expect(screen.queryByRole("button", { name: /^import/i })).toBeNull();
    await consent(user);
    await user.click(screen.getByRole("button", { name: /check the file/i }));
    expect(await screen.findByText(/1 will be added/i)).toBeInTheDocument();
    expect(screen.getByText(/1 opted out earlier and will be skipped/i)).toBeInTheDocument();
    expect(api.importWhatsAppContacts).toHaveBeenCalledWith(
      expect.objectContaining({ socialAccountId: SA1, source: "customer_import", capturedAt: "2026-10-01", consentText: "Ticked the WhatsApp offers box at checkout", dryRun: true }),
    );
    await user.click(screen.getByRole("button", { name: /import 1 contact/i }));
    await waitFor(() => expect(api.importWhatsAppContacts).toHaveBeenCalledTimes(2));
    expect(api.importWhatsAppContacts).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: false }));
    expect(await screen.findByText(/import finished/i)).toBeInTheDocument();
    expect(onImported).toHaveBeenCalled();
  });

  it("drops the check when the consent details change, so what is imported is what was checked", async () => {
    const user = userEvent.setup();
    api.importWhatsAppContacts.mockResolvedValue({ dryRun: true, accepted: 1, duplicates: 0, suppressed: 0, rejected: [] });
    render(<WhatsAppContactImport socialAccountId={SA1} onImported={() => {}} />);
    await pick(user, "phone,opted_in\n+27 82 123 4567,yes\n");
    await screen.findByText(/1 contact found/i);
    await consent(user);
    await user.click(screen.getByRole("button", { name: /check the file/i }));
    await screen.findByRole("button", { name: /import 1 contact/i });
    await user.type(screen.getByLabelText(/what did they agree to/i), " (updated)");
    expect(screen.queryByRole("button", { name: /import 1 contact/i })).toBeNull();
  });

  it("marks the import area so session replay never records it", () => {
    const { container } = render(<WhatsAppContactImport socialAccountId={SA1} onImported={() => {}} />);
    expect(container.querySelector(".ph-no-capture")).not.toBeNull();
  });
});

describe("whatsapp-contacts.css", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles/whatsapp-contacts.css"), "utf8");

  it("gives instant press feedback, animates only transform and opacity, and has the three accessibility fallbacks", () => {
    expect(css).toMatch(/:active/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
    expect(css).toMatch(/@media \(prefers-contrast: more\)/);
    expect(css).toMatch(/touch-action: manipulation/);
    for (const m of css.matchAll(/transition\s*:\s*([^;]+);/g)) {
      const props = m[1].split(",").map((p) => p.trim().split(/\s+/)[0]);
      for (const p of props) expect(["transform", "opacity", "none"], `transition on ${p}`).toContain(p);
    }
    expect(css).not.toMatch(/transition-property\s*:\s*(?!transform|opacity)/);
  });
});
