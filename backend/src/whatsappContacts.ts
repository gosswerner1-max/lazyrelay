// WhatsApp broadcast contacts and consent (Phase 1: contacts and consent only; nothing here sends a message or calls Meta).
//
// What is stored for a contact the customer uploads (migration 0128):
//   - the number only as an AES-256-GCM envelope (phoneVault.ts), bound to the account and contact key;
//   - contact_key, the keyed account-scoped hash that also matches inbound messages; contact_display, a mask;
//   - a consent record in whatsapp_opt_ins: append-only and hash chained per contact, so an edited or removed record shows.
// Opt-outs live in a separate hash-only table that never links to a contact, so erasing a contact keeps the suppression and a
// re-import can never subscribe the person again (checked here for a clear answer, and again by a database trigger).
//
// All writes use the service-role client. Nothing here logs a number, a name or the consent wording.

import { createHash, randomUUID } from "node:crypto";
import { supabase } from "./supabase.js";
import { contactHashKey, contactKeyFor, maskPhone } from "./platforms/whatsapp/contactPrivacy.js";
import { normalizePhone } from "./platforms/whatsapp/phone.js";
import { encryptPhone, phoneVaultConfigured } from "./platforms/whatsapp/phoneVault.js";

export const OPT_IN_SOURCES = ["customer_import", "website_form", "whatsapp_inbound", "click_to_whatsapp_ad", "in_person", "phone_call", "qr_code", "other"] as const;
export type OptInSource = (typeof OPT_IN_SOURCES)[number];

/** Version of the attestation wording the customer ticks (frontend/src/lib/whatsappAttestation.ts). Bump both together. */
export const ATTESTATION_VERSION = "2026-10-15.1";
export const GENESIS_HASH = "0".repeat(64);
export const MAX_NAME_LENGTH = 80;
export const MAX_IMPORT_ROWS = 5000;

// ---------------------------------------------------------------------------------------------------------------------
// Consent evidence hash chain
// ---------------------------------------------------------------------------------------------------------------------

export interface OptInHashFields {
  prevHash: string;
  accountId: string;
  contactId: string;
  source: string;
  capturedAt: string;
  recordedAt: string;
  recordedBy: string | null;
  consentText: string;
  proofReference: string | null;
  attested: boolean;
  attestationVersion: string;
  importBatchId: string | null;
}

/** SHA-256 over a JSON array of the row's fields in a fixed order (JSON quoting keeps field boundaries unambiguous). */
export function computeOptInRowHash(f: OptInHashFields): string {
  const canonical = JSON.stringify([
    "lr-wa-optin-v1",
    f.prevHash,
    f.accountId,
    f.contactId,
    f.source,
    f.capturedAt,
    f.recordedAt,
    f.recordedBy,
    f.consentText,
    f.proofReference,
    f.attested,
    f.attestationVersion,
    f.importBatchId,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Checks one contact's records, oldest first: the first starts at the genesis hash, each links to the one before, and every
 *  stored row_hash matches its fields. */
export function verifyOptInChain(rows: Array<OptInHashFields & { rowHash: string }>): { ok: true } | { ok: false; brokenAt: number } {
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].prevHash !== expectedPrev || computeOptInRowHash(rows[i]) !== rows[i].rowHash) return { ok: false, brokenAt: i };
    expectedPrev = rows[i].rowHash;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------------------------------------------------

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** "2026-10-01" (read as midnight UTC) or a full ISO time with a zone; anything else is null. */
export function parseConsentDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d) ? date : null;
  }
  if (ISO_DATETIME.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

const AFFIRMATIVE = new Set(["yes", "y", "true", "1", "opted_in", "opted in", "opt-in", "opt in", "optin"]);

/** A clear yes. An empty cell, "no", "maybe" or anything unexpected is NOT consent. */
export function isAffirmative(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && AFFIRMATIVE.has(value.trim().toLowerCase());
}

/** A display name: control characters removed, at most 80 characters, and no long digit run (a number typed in the name field
 *  would end up on screen). Empty is fine (null). */
export function cleanDisplayName(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name.length > MAX_NAME_LENGTH || /\d{7,}/.test(name.replace(/[\s().+-]/g, ""))) return { ok: false };
  return { ok: true, value: name === "" ? null : name };
}

// ---------------------------------------------------------------------------------------------------------------------
// Adding contacts (one or a whole import)
// ---------------------------------------------------------------------------------------------------------------------

export class ContactStorageNotConfiguredError extends Error {
  constructor() {
    super("Contact storage keys are not configured.");
    this.name = "ContactStorageNotConfiguredError";
  }
}

/** True when both secrets exist: the hash key (contact_key) and the encryption key. Without them nothing is stored. */
export function contactStorageReady(): boolean {
  return contactHashKey() !== null && phoneVaultConfigured();
}

export interface OptInEvidence {
  source: OptInSource;
  capturedAt: Date;
  consentText: string;
  proofReference: string | null;
  attestationVersion: string;
  importBatchId: string | null;
}

export interface AddContactItem {
  phone: unknown;
  name?: unknown;
  evidence: OptInEvidence;
  /** A reason the caller already found (e.g. no affirmative opt-in): the row passes through as rejected, order kept. */
  rejectReason?: string;
}

export interface AddContext {
  accountId: string;
  socialAccountId: string;
  recordedBy: string | null;
}

export type AddResult = { status: "accepted" | "duplicate" | "suppressed" } | { status: "rejected"; reason: string };

const LOOKUP_CHUNK = 100;
const WRITE_CHUNK = 500;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what}: ${error.message}`);
}

interface Pending {
  index: number;
  contactKey: string;
  e164: string;
  digits: string;
  countryCallingCode: string;
  name: string | null;
  evidence: OptInEvidence;
}

/** Validates, de-duplicates, checks the suppression list and (unless dryRun) stores every item. Results come back in the order
 *  of the items. Throws ContactStorageNotConfiguredError before doing anything if a key is missing (fail closed). */
export async function addContacts(ctx: AddContext, items: AddContactItem[], opts: { dryRun: boolean; now?: Date }): Promise<AddResult[]> {
  if (!contactStorageReady()) throw new ContactStorageNotConfiguredError();
  const now = opts.now ?? new Date();
  const results: AddResult[] = new Array(items.length);
  const pending: Pending[] = [];
  const seen = new Set<string>();

  items.forEach((item, index) => {
    if (item.rejectReason) {
      results[index] = { status: "rejected", reason: item.rejectReason };
      return;
    }
    const phone = normalizePhone(item.phone);
    if (!phone.ok) {
      results[index] = { status: "rejected", reason: `phone_${phone.reason}` };
      return;
    }
    const name = cleanDisplayName(item.name);
    if (!name.ok) {
      results[index] = { status: "rejected", reason: "name_invalid" };
      return;
    }
    if (item.evidence.capturedAt.getTime() > now.getTime()) {
      results[index] = { status: "rejected", reason: "opt_in_date_in_future" };
      return;
    }
    const contactKey = contactKeyFor(ctx.accountId, phone.digits);
    if (!contactKey) throw new ContactStorageNotConfiguredError();
    if (seen.has(contactKey)) {
      results[index] = { status: "duplicate" };
      return;
    }
    seen.add(contactKey);
    pending.push({ index, contactKey, e164: phone.e164, digits: phone.digits, countryCallingCode: phone.countryCallingCode, name: name.value, evidence: item.evidence });
  });

  // Suppression list first: a number that opted out is never stored again, whatever the file says.
  const suppressed = new Set<string>();
  for (const part of chunks(pending.map((p) => p.contactKey), LOOKUP_CHUNK)) {
    for (const column of ["contact_key", "wa_contact_key"] as const) {
      const { data, error } = await supabase.from("whatsapp_opt_outs").select("contact_key, wa_contact_key").eq("account_id", ctx.accountId).in(column, part);
      if (error) fail("opt-out lookup failed", error);
      for (const r of (data ?? []) as Array<{ contact_key: string; wa_contact_key: string | null }>) suppressed.add(r[column] as string);
    }
  }

  // Already stored for this connection: a duplicate, or suppressed if that stored contact has opted out.
  const existing = new Map<string, string>();
  for (const part of chunks(pending.map((p) => p.contactKey), LOOKUP_CHUNK)) {
    const { data, error } = await supabase.from("whatsapp_contacts").select("contact_key, consent_status").eq("social_account_id", ctx.socialAccountId).in("contact_key", part);
    if (error) fail("contact lookup failed", error);
    for (const r of (data ?? []) as Array<{ contact_key: string; consent_status: string }>) existing.set(r.contact_key, r.consent_status);
  }

  const toStore: Pending[] = [];
  for (const p of pending) {
    if (suppressed.has(p.contactKey) || existing.get(p.contactKey) === "opted_out") results[p.index] = { status: "suppressed" };
    else if (existing.has(p.contactKey)) results[p.index] = { status: "duplicate" };
    else {
      results[p.index] = { status: "accepted" };
      toStore.push(p);
    }
  }

  if (!opts.dryRun) for (const part of chunks(toStore, WRITE_CHUNK)) await storeChunk(ctx, part, now);
  return results;
}

async function storeChunk(ctx: AddContext, part: Pending[], now: Date): Promise<void> {
  const recordedAt = now.toISOString();
  const contactRows: Record<string, unknown>[] = [];
  const optInRows: Record<string, unknown>[] = [];
  for (const p of part) {
    const contactId = randomUUID();
    const optInId = randomUUID();
    const capturedAt = p.evidence.capturedAt.toISOString();
    contactRows.push({
      id: contactId,
      account_id: ctx.accountId,
      social_account_id: ctx.socialAccountId,
      contact_key: p.contactKey,
      wa_contact_key: null,
      contact_display: maskPhone(p.digits),
      phone_ciphertext: encryptPhone(ctx.accountId, p.contactKey, p.e164),
      country_calling_code: p.countryCallingCode,
      display_name: p.name,
      consent_status: "opted_in",
      opted_in_at: capturedAt,
      opted_out_at: null,
      current_opt_in_id: optInId,
    });
    const hashFields: OptInHashFields = {
      prevHash: GENESIS_HASH,
      accountId: ctx.accountId,
      contactId,
      source: p.evidence.source,
      capturedAt,
      recordedAt,
      recordedBy: ctx.recordedBy,
      consentText: p.evidence.consentText,
      proofReference: p.evidence.proofReference,
      attested: true,
      attestationVersion: p.evidence.attestationVersion,
      importBatchId: p.evidence.importBatchId,
    };
    optInRows.push({
      id: optInId,
      account_id: ctx.accountId,
      contact_id: contactId,
      source: hashFields.source,
      captured_at: capturedAt,
      recorded_at: recordedAt,
      recorded_by: hashFields.recordedBy,
      consent_text: hashFields.consentText,
      proof_reference: hashFields.proofReference,
      attested: true,
      attestation_version: hashFields.attestationVersion,
      import_batch_id: hashFields.importBatchId,
      prev_hash: hashFields.prevHash,
      row_hash: computeOptInRowHash(hashFields),
    });
  }
  const contactIns = await supabase.from("whatsapp_contacts").insert(contactRows);
  if (contactIns.error) fail("contact insert failed", contactIns.error);
  const optInIns = await supabase.from("whatsapp_opt_ins").insert(optInRows);
  if (optInIns.error) {
    // Never leave a contact without its consent record: take this chunk's contacts back out.
    await supabase.from("whatsapp_contacts").delete().in("id", contactRows.map((r) => r.id as string));
    fail("consent insert failed", optInIns.error);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Opt-out and erase
// ---------------------------------------------------------------------------------------------------------------------

/** Manual opt-out: adds the hash-only suppression row (once) and marks the contact opted out. False when the contact is not
 *  this account's. */
export async function optOutContact(accountId: string, contactId: string): Promise<boolean> {
  const found = await supabase.from("whatsapp_contacts").select("id, contact_key, wa_contact_key, contact_display").eq("id", contactId).eq("account_id", accountId).maybeSingle();
  if (found.error) fail("contact lookup failed", found.error);
  const contact = found.data as { id: string; contact_key: string; wa_contact_key: string | null; contact_display: string } | null;
  if (!contact) return false;
  const now = new Date().toISOString();
  const ins = await supabase.from("whatsapp_opt_outs").upsert(
    { account_id: accountId, contact_key: contact.contact_key, contact_display: contact.contact_display, wa_contact_key: contact.wa_contact_key, scope: "all", source: "manual", keyword: null, occurred_at: now },
    { onConflict: "account_id,contact_key,scope", ignoreDuplicates: true },
  );
  if (ins.error) fail("opt-out insert failed", ins.error);
  // The database trigger does this too; doing it here as well keeps the answer right even if the trigger were missing.
  const upd = await supabase.from("whatsapp_contacts").update({ consent_status: "opted_out", opted_out_at: now, updated_at: now }).eq("id", contactId).eq("account_id", accountId);
  if (upd.error) fail("contact update failed", upd.error);
  return true;
}

/** Erase: deletes the contact (and, by cascade, its consent records and encrypted number). The hash-only opt-out list is not
 *  touched. False when there was no such contact for this account. */
export async function eraseContact(accountId: string, contactId: string): Promise<boolean> {
  const { data, error } = await supabase.from("whatsapp_contacts").delete().eq("id", contactId).eq("account_id", accountId).select("id");
  if (error) fail("contact delete failed", error);
  return ((data as unknown[] | null) ?? []).length > 0;
}
