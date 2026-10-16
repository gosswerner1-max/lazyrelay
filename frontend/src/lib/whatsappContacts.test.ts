import { describe, it, expect, vi } from "vitest";

// dashboardHelpers (the CSV reader) imports the API client, which builds a Supabase client at import time.
vi.mock("./supabase", () => ({ supabase: {} }));
import {
  ATTESTATION_TEXT,
  ATTESTATION_VERSION,
  MAX_IMPORT_ROWS,
  OPT_IN_SOURCES,
  isAffirmativeCell,
  looksLikePhone,
  maskPhoneLocal,
  parseContactsCsv,
  previewImport,
  todayUtc,
  validateOptInDetails,
  validateAddContact,
} from "./whatsappContacts";

describe("attestation wording", () => {
  it("is the approved five-part wording and carries a version the backend stores", () => {
    expect(ATTESTATION_VERSION).toBe("2026-10-15.1");
    for (const part of ["(1) I am entitled to message each number on WhatsApp for marketing", "(2) each person gave explicit opt-in consent", "(3) this list was not bought, rented, scraped or inferred", "(4) I will honour opt-outs", "(5) I am responsible for lawful use"]) {
      expect(ATTESTATION_TEXT).toContain(part);
    }
    expect(ATTESTATION_TEXT.startsWith("I confirm that")).toBe(true);
  });

  it("offers the eight sources the database allows", () => {
    expect(OPT_IN_SOURCES.map((s) => s.value).sort()).toEqual(["click_to_whatsapp_ad", "customer_import", "in_person", "other", "phone_call", "qr_code", "website_form", "whatsapp_inbound"]);
  });
});

describe("looksLikePhone and maskPhoneLocal", () => {
  it("accepts international forms and rejects national numbers, letters and wrong lengths", () => {
    for (const ok of ["+27 82 123 4567", "0027821234567", "27821234567", "+1 (415) 555-2671"]) expect(looksLikePhone(ok), ok).toBe(true);
    for (const bad of ["0821234567", "abc", "", "+27 82 12", "+1234567890123456"]) expect(looksLikePhone(bad), bad).toBe(false);
  });

  it("masks like the server: country code and last digits only, never seven digits in a row", () => {
    expect(maskPhoneLocal("+27 82 123 4567")).toBe("+27 ** *** 4567");
    expect(maskPhoneLocal("+1 415 555 2671")).toBe("+1 ** *** 2671");
    for (const raw of ["+27821234567", "+442079460958", "27821234567"]) expect(maskPhoneLocal(raw)).not.toMatch(/(?:\d[\s().-]?){7,}/);
  });
});

describe("isAffirmativeCell", () => {
  it("only a clear yes counts", () => {
    for (const v of ["yes", "Y", "TRUE", "1", "opted_in", "Opted in"]) expect(isAffirmativeCell(v)).toBe(true);
    for (const v of ["", "no", "0", "maybe", "unsubscribed", " "]) expect(isAffirmativeCell(v)).toBe(false);
  });
});

describe("parseContactsCsv", () => {
  it("reads a file with the mandatory columns, tolerating header spelling, quotes and CRLF", () => {
    const r = parseContactsCsv('Phone Number,Full Name,Opted In,Opt-in Date\r\n+27821234567,"Nkosi, Thandi",yes,2026-09-01\r\n+27831234567,Pieter,no,\r\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toEqual([
      { phone: "+27821234567", name: "Nkosi, Thandi", opted_in: "yes", opt_in_date: "2026-09-01" },
      { phone: "+27831234567", name: "Pieter", opted_in: "no", opt_in_date: "" },
    ]);
  });

  it("refuses a file with no opted_in column: consent cannot be assumed", () => {
    const r = parseContactsCsv("phone,name\n+27821234567,Thandi\n");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/opted_in/) });
  });

  it("refuses a file with no phone column, no rows, or too many rows", () => {
    expect(parseContactsCsv("name,opted_in\nThandi,yes\n")).toEqual({ ok: false, error: expect.stringMatching(/phone/) });
    expect(parseContactsCsv("phone,opted_in\n")).toEqual({ ok: false, error: expect.stringMatching(/no contacts/i) });
    expect(parseContactsCsv("")).toEqual({ ok: false, error: expect.any(String) });
    const many = "phone,opted_in\n" + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `+2782${1000000 + i},yes`).join("\n");
    expect(parseContactsCsv(many)).toEqual({ ok: false, error: expect.stringMatching(/5,000/) });
    const exact = "phone,opted_in\n" + Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `+2782${1000000 + i},yes`).join("\n");
    expect(parseContactsCsv(exact).ok).toBe(true);
  });

  it("refuses an oversize file", () => {
    expect(parseContactsCsv("phone,opted_in\n" + "x".repeat(1_100_000))).toEqual({ ok: false, error: expect.stringMatching(/too large/i) });
  });
});

describe("previewImport", () => {
  const rows = [
    { phone: "+27 82 123 4567", name: "Thandi", opted_in: "yes", opt_in_date: "2026-09-01" },
    { phone: "+27 83 123 4567", name: "Pieter", opted_in: "no", opt_in_date: "" },
    { phone: "0841234567", name: "", opted_in: "yes", opt_in_date: "" },
    { phone: "+27 85 123 4567", name: "", opted_in: "yes", opt_in_date: "2999-01-01" },
    { phone: "+27 82 123 4567", name: "Dup", opted_in: "yes", opt_in_date: "" },
    { phone: "", name: "Empty", opted_in: "yes", opt_in_date: "" },
    { phone: "+27 86 123 4567", name: "Soon", opted_in: "yes", opt_in_date: "01/09/2026" },
  ];

  it("flags every row that would be rejected, with the same row numbers and codes the server uses, and masks numbers", () => {
    const p = previewImport(rows, "2026-10-15");
    expect(p.total).toBe(7);
    expect(p.ready).toBe(1);
    expect(p.problems).toEqual([
      { row: 2, reason: "opt_in_not_affirmative" },
      { row: 3, reason: "phone_leading_zero_without_country_code" },
      { row: 4, reason: "opt_in_date_in_future" },
      { row: 5, reason: "duplicate_in_file" },
      { row: 6, reason: "phone_empty" },
      { row: 7, reason: "opt_in_date_invalid" },
    ]);
    expect(p.sample[0]).toEqual({ row: 1, display: "+27 ** *** 4567", name: "Thandi" });
    expect(JSON.stringify(p)).not.toMatch(/(?:\d[\s().-]?){7,}/);
  });
});

describe("validateOptInDetails and validateAddContact", () => {
  const good = { source: "website_form", capturedAt: "2026-10-01", consentText: "I agree to get offers", proofReference: "", attested: true };

  it("passes complete details", () => {
    expect(validateOptInDetails(good, "2026-10-15")).toEqual({});
  });

  it("requires a source, a past date, consent wording, a short proof reference and the attestation", () => {
    expect(validateOptInDetails({ ...good, source: "" }, "2026-10-15").source).toBeTruthy();
    expect(validateOptInDetails({ ...good, source: "bought_list" }, "2026-10-15").source).toBeTruthy();
    expect(validateOptInDetails({ ...good, capturedAt: "" }, "2026-10-15").capturedAt).toBeTruthy();
    expect(validateOptInDetails({ ...good, capturedAt: "2026-10-16" }, "2026-10-15").capturedAt).toMatch(/future/i);
    expect(validateOptInDetails({ ...good, capturedAt: "yesterday" }, "2026-10-15").capturedAt).toBeTruthy();
    expect(validateOptInDetails({ ...good, consentText: "   " }, "2026-10-15").consentText).toBeTruthy();
    expect(validateOptInDetails({ ...good, consentText: "x".repeat(1001) }, "2026-10-15").consentText).toBeTruthy();
    expect(validateOptInDetails({ ...good, proofReference: "x".repeat(501) }, "2026-10-15").proofReference).toBeTruthy();
    expect(validateOptInDetails({ ...good, attested: false }, "2026-10-15").attested).toBeTruthy();
  });

  it("adds a phone check for a single contact", () => {
    expect(validateAddContact({ ...good, phone: "+27 82 123 4567", name: "" }, "2026-10-15")).toEqual({});
    expect(validateAddContact({ ...good, phone: "0821234567", name: "" }, "2026-10-15").phone).toBeTruthy();
    expect(validateAddContact({ ...good, phone: "", name: "" }, "2026-10-15").phone).toBeTruthy();
    expect(validateAddContact({ ...good, phone: "+27 82 123 4567", name: "x".repeat(81) }, "2026-10-15").name).toBeTruthy();
    expect(validateAddContact({ ...good, phone: "+27 82 123 4567", name: "", attested: false }, "2026-10-15").attested).toBeTruthy();
  });
});

describe("todayUtc", () => {
  it("is a YYYY-MM-DD date", () => {
    expect(todayUtc(new Date("2026-10-15T23:30:00Z"))).toBe("2026-10-15");
  });
});
