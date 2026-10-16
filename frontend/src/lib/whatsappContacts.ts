// Pure helpers for the WhatsApp contacts and consent screens (Phase 1: contacts and consent only, nothing is sent). The backend
// is the authority on every rule below (routes/whatsappContacts.routes.ts); these run first so the customer sees problems
// before anything is uploaded, using the same reason codes and the same row numbers (row 1 = first contact under the header).
//
// A contact's number is never shown back: lists and previews use a mask such as "+27 ** *** 4567", and a name or mask that
// still looks like a long number is replaced (see safeDisplay / safeName in whatsappThreads.ts).

import { parseCsv } from "../pages/dashboard/dashboardHelpers";

/** Version of the wording below; the backend stores it with every consent record. Keep in step with ATTESTATION_VERSION there. */
export const ATTESTATION_VERSION = "2026-10-15.1";

export const ATTESTATION_TEXT =
  "I confirm that (1) I am entitled to message each number on WhatsApp for marketing; (2) each person gave explicit opt-in consent to receive marketing messages from my business on WhatsApp before today and I hold proof; (3) this list was not bought, rented, scraped or inferred; (4) I will honour opt-outs and understand LazyRelay blocks opted-out numbers automatically; (5) I am responsible for lawful use under the laws that apply to me and under Meta's WhatsApp Business Messaging Policy.";

export const OPT_IN_SOURCES = [
  { value: "customer_import", label: "A customer list I already hold" },
  { value: "website_form", label: "Website sign-up form" },
  { value: "whatsapp_inbound", label: "They messaged me on WhatsApp first" },
  { value: "click_to_whatsapp_ad", label: "Click-to-WhatsApp ad" },
  { value: "in_person", label: "In person" },
  { value: "phone_call", label: "Phone call" },
  { value: "qr_code", label: "QR code" },
  { value: "other", label: "Other" },
] as const;

export const MAX_IMPORT_ROWS = 5000;
/** Characters, not bytes; keeps the request well under the server's 2 MB limit. */
export const MAX_CSV_CHARS = 1_000_000;
export const MAX_CONSENT_TEXT = 1000;
export const MAX_PROOF_REFERENCE = 500;
export const MAX_NAME = 80;

// ---------------------------------------------------------------------------------------------------------------------
// Phone numbers (a sanity check only; the server normalises and decides)
// ---------------------------------------------------------------------------------------------------------------------

type DigitsResult = { ok: true; digits: string } | { ok: false; reason: "phone_empty" | "phone_invalid_characters" | "phone_leading_zero_without_country_code" | "phone_too_short" | "phone_too_long" };

function toDigits(raw: string): DigitsResult {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "phone_empty" };
  if (!/^\+?[0-9\s().-]+$/.test(text)) return { ok: false, reason: "phone_invalid_characters" };
  let digits = text.replace(/\D/g, "");
  const international = text.startsWith("+") || digits.startsWith("00");
  if (!text.startsWith("+") && digits.startsWith("00")) digits = digits.slice(2);
  if (!international && digits.startsWith("0")) return { ok: false, reason: "phone_leading_zero_without_country_code" };
  if (digits.length < 8) return { ok: false, reason: "phone_too_short" };
  if (digits.length > 15) return { ok: false, reason: "phone_too_long" };
  return { ok: true, digits };
}

export function looksLikePhone(raw: string): boolean {
  return toDigits(raw).ok;
}

/** The mask the server shows: country code and the last 3 or 4 digits, at least three digits always hidden. */
export function maskPhoneLocal(raw: string): string {
  const r = toDigits(raw);
  if (!r.ok) return "(not a valid number)";
  const digits = r.digits;
  const len = digits.length;
  let head = digits.startsWith("1") || digits.startsWith("7") ? 1 : 2;
  let tail = len >= 10 ? 4 : 3;
  while (head + tail > len - 3 && tail > 0) tail -= 1;
  while (head + tail > len - 3 && head > 0) head -= 1;
  return `${head > 0 ? `+${digits.slice(0, head)} ` : ""}** ***${tail > 0 ? ` ${digits.slice(len - tail)}` : ""}`;
}

const AFFIRMATIVE = new Set(["yes", "y", "true", "1", "opted_in", "opted in", "opt-in", "opt in", "optin"]);
/** A clear yes. An empty cell, "no" or anything unexpected is not consent. */
export function isAffirmativeCell(value: string): boolean {
  return AFFIRMATIVE.has(value.trim().toLowerCase());
}

// ---------------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------------

/** Today as YYYY-MM-DD in UTC (what the server compares against). */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** "valid", "invalid", or "future" for a consent date given as YYYY-MM-DD or a full ISO time. */
function dateState(value: string, today: string): "valid" | "invalid" | "future" {
  const text = value.trim();
  const m = DATE_ONLY.exec(text);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return "invalid";
    return text > today ? "future" : "valid";
  }
  if (ISO_DATETIME.test(text)) {
    const t = new Date(text).getTime();
    if (Number.isNaN(t)) return "invalid";
    return t > new Date(`${today}T23:59:59.999Z`).getTime() ? "future" : "valid";
  }
  return "invalid";
}

// ---------------------------------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------------------------------

export interface ImportRow {
  phone: string;
  name: string;
  opted_in: string;
  opt_in_date: string;
}

export type CsvParseResult = { ok: true; rows: ImportRow[] } | { ok: false; error: string };

const HEADER_ALIASES: Record<keyof ImportRow, string[]> = {
  phone: ["phone", "phone_number", "mobile", "mobile_number", "whatsapp", "whatsapp_number", "number", "cell"],
  name: ["name", "full_name", "first_name", "contact_name", "display_name"],
  opted_in: ["opted_in", "optin", "opt_in", "consent", "whatsapp_consent", "opted_in_whatsapp"],
  opt_in_date: ["opt_in_date", "optin_date", "opted_in_date", "consent_date", "date_opted_in"],
};

const headerKey = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Reads a customer's CSV. The file MUST have a phone column and an opted_in column: consent is never assumed. */
export function parseContactsCsv(text: string): CsvParseResult {
  if (text.length > MAX_CSV_CHARS) return { ok: false, error: "That file is too large. Keep it under 1 MB and 5,000 contacts." };
  const table = parseCsv(text.replace(/^﻿/, ""));
  if (table.length === 0) return { ok: false, error: "That file is empty." };
  const header = table[0].map(headerKey);
  const index = {} as Record<keyof ImportRow, number>;
  for (const field of Object.keys(HEADER_ALIASES) as Array<keyof ImportRow>) index[field] = header.findIndex((h) => HEADER_ALIASES[field].includes(h));
  if (index.phone < 0) return { ok: false, error: "The file needs a phone column in its first row (a column headed phone)." };
  if (index.opted_in < 0) return { ok: false, error: "The file needs an opted_in column. LazyRelay only stores people who said yes, so every row must say yes or no in opted_in." };
  const data = table.slice(1);
  if (data.length === 0) return { ok: false, error: "The file has no contacts under the first row." };
  if (data.length > MAX_IMPORT_ROWS) return { ok: false, error: "That file has more than 5,000 contacts. Split it into smaller files." };
  const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
  return {
    ok: true,
    rows: data.map((row) => ({ phone: cell(row, index.phone), name: cell(row, index.name), opted_in: cell(row, index.opted_in), opt_in_date: cell(row, index.opt_in_date) })),
  };
}

export interface ImportPreview {
  total: number;
  ready: number;
  problems: Array<{ row: number; reason: string }>;
  /** The first few rows that look fine, masked. */
  sample: Array<{ row: number; display: string; name: string }>;
}

/** What the server will most likely do with each row. Reason codes and row numbers match the server's. */
export function previewImport(rows: ImportRow[], today: string = todayUtc()): ImportPreview {
  const problems: ImportPreview["problems"] = [];
  const sample: ImportPreview["sample"] = [];
  const seen = new Set<string>();
  let ready = 0;
  rows.forEach((r, i) => {
    const row = i + 1;
    const fail = (reason: string) => problems.push({ row, reason });
    if (!isAffirmativeCell(r.opted_in)) return fail("opt_in_not_affirmative");
    const hasDate = r.opt_in_date.trim() !== "";
    const state = hasDate ? dateState(r.opt_in_date, today) : "valid";
    if (state === "invalid") return fail("opt_in_date_invalid");
    const phone = toDigits(r.phone);
    if (!phone.ok) return fail(phone.reason);
    if (state === "future") return fail("opt_in_date_in_future");
    if (seen.has(phone.digits)) return fail("duplicate_in_file");
    seen.add(phone.digits);
    ready += 1;
    if (sample.length < 5) sample.push({ row, display: maskPhoneLocal(r.phone), name: r.name });
  });
  return { total: rows.length, ready, problems, sample };
}

/** Plain-language version of a reason code from the preview or from the server. */
export function describeReason(reason: string): string {
  const known: Record<string, string> = {
    opt_in_not_affirmative: "opted_in is not a clear yes",
    opt_in_date_invalid: "the opt-in date is not a date like 2026-10-01",
    opt_in_date_in_future: "the opt-in date is in the future",
    duplicate_in_file: "the same number appears earlier in the file",
    phone_empty: "no phone number",
    phone_invalid_characters: "the phone number has characters that are not allowed",
    phone_leading_zero_without_country_code: "the number starts with 0 and has no country code (use +27 ...)",
    phone_too_short: "the phone number is too short",
    phone_too_long: "the phone number is too long",
    phone_unknown_country_code: "the country code is not recognised",
    name_invalid: "the name is too long or looks like a phone number",
    row_invalid: "the row could not be read",
  };
  return known[reason] ?? "the row could not be accepted";
}

// ---------------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------------

export interface OptInDetails {
  source: string;
  capturedAt: string;
  consentText: string;
  proofReference: string;
  attested: boolean;
}

export type FormErrors = Partial<Record<"phone" | "name" | "source" | "capturedAt" | "consentText" | "proofReference" | "attested", string>>;

/** The consent evidence shared by the single form and the import. Empty object means valid. */
export function validateOptInDetails(d: OptInDetails, today: string = todayUtc()): FormErrors {
  const errors: FormErrors = {};
  if (!OPT_IN_SOURCES.some((s) => s.value === d.source)) errors.source = "Choose where the consent came from.";
  if (d.capturedAt.trim() === "") errors.capturedAt = "Enter the date they gave consent.";
  else {
    const state = dateState(d.capturedAt, today);
    if (state === "invalid") errors.capturedAt = "Enter the date as YYYY-MM-DD, for example 2026-10-01.";
    else if (state === "future") errors.capturedAt = "The consent date cannot be in the future.";
  }
  const text = d.consentText.trim();
  if (text === "") errors.consentText = "Write down what the person agreed to, in the words they saw.";
  else if (text.length > MAX_CONSENT_TEXT) errors.consentText = "Keep this under 1,000 characters.";
  if (d.proofReference.trim().length > MAX_PROOF_REFERENCE) errors.proofReference = "Keep this under 500 characters.";
  if (!d.attested) errors.attested = "Tick the box to confirm before adding contacts.";
  return errors;
}

export interface AddContactForm extends OptInDetails {
  phone: string;
  name: string;
}

export function validateAddContact(f: AddContactForm, today: string = todayUtc()): FormErrors {
  const errors = validateOptInDetails(f, today);
  if (f.phone.trim() === "") errors.phone = "Enter the phone number with its country code, for example +27 82 123 4567.";
  else if (!looksLikePhone(f.phone)) errors.phone = "That number does not look right. Use the international form, for example +27 82 123 4567.";
  if (f.name.trim().length > MAX_NAME) errors.name = "Keep the name under 80 characters.";
  return errors;
}
