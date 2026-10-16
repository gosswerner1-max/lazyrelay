// "Start a conversation" from a typed phone number (Direct Entry). The customer types a number and clicks Start chat; the system, not the
// browser, writes the consent record, so the record can never claim more than what happened:
//   source "direct_entry", captured_at = the moment of the click (NOT a date the contact gave consent: nobody stated one),
//   consent_text = the exact sentence shown under the input, attestation_version = the Direct Entry wording version below.
// A number that already exists keeps its own (stronger) consent evidence: nothing is added on top. A number that opted out is refused.
// The first message to a new chat is still a template (Meta's 24 hour rule), unchanged.

import { supabase } from "../supabase.js";
import { contactKeyFor } from "../platforms/whatsapp/contactPrivacy.js";
import { normalizePhone } from "../platforms/whatsapp/phone.js";
import { ContactStorageNotConfiguredError, addContacts, contactStorageReady } from "../whatsappContacts.js";
import { startConversation } from "./conversations.js";

/** Shown under the input in the dashboard and stored as the consent wording. Change both together (frontend/src/lib/whatsappDirectEntry.ts). */
export const DIRECT_ENTRY_CONSENT_TEXT = "By initializing this chat, you confirm compliance with Meta's user opt-in messaging policies.";
/** Bump when DIRECT_ENTRY_CONSENT_TEXT changes. */
export const DIRECT_ENTRY_ATTESTATION_VERSION = "direct-entry-2026-10-16.1";

export interface DirectChatContext {
  accountId: string;
  socialAccountId: string;
  recordedBy: string | null;
}

export type DirectChatOutcome =
  | { ok: true; created: boolean; contactCreated: boolean; conversationId: string; contactDisplay: string }
  | { ok: false; code: "invalid_phone" | "opted_out" | "not_found" | "no_number" };

export async function startDirectChat(ctx: DirectChatContext, phone: unknown, now: Date = new Date()): Promise<DirectChatOutcome> {
  if (!contactStorageReady()) throw new ContactStorageNotConfiguredError();

  const conn = await supabase.from("social_accounts").select("id").eq("id", ctx.socialAccountId).eq("account_id", ctx.accountId).eq("platform", "whatsapp").is("disconnected_at", null).maybeSingle();
  if (conn.error) throw new Error(`connection lookup failed: ${conn.error.message}`);
  if (!conn.data) return { ok: false, code: "not_found" };

  const parsed = normalizePhone(phone);
  if (!parsed.ok) return { ok: false, code: "invalid_phone" };
  const contactKey = contactKeyFor(ctx.accountId, parsed.digits);
  if (!contactKey) throw new ContactStorageNotConfiguredError();

  const [added] = await addContacts(
    ctx,
    [{ phone, evidence: { source: "direct_entry", capturedAt: now, consentText: DIRECT_ENTRY_CONSENT_TEXT, proofReference: null, attestationVersion: DIRECT_ENTRY_ATTESTATION_VERSION, importBatchId: null } }],
    { dryRun: false, now },
  );
  if (added.status === "rejected") return { ok: false, code: "invalid_phone" };
  if (added.status === "suppressed") return { ok: false, code: "opted_out" };

  const found = await supabase.from("whatsapp_contacts").select("id").eq("social_account_id", ctx.socialAccountId).eq("contact_key", contactKey).maybeSingle();
  if (found.error) throw new Error(`contact lookup failed: ${found.error.message}`);
  const contactId = (found.data as { id: string } | null)?.id;
  if (!contactId) return { ok: false, code: "not_found" };

  const chat = await startConversation(ctx.accountId, contactId, now);
  if (!chat.ok) return { ok: false, code: chat.code };
  return { ok: true, created: chat.created, contactCreated: added.status === "accepted", conversationId: chat.conversationId, contactDisplay: chat.contactDisplay };
}
