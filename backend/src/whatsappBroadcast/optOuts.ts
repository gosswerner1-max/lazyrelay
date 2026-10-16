// Opt-outs. Two things start one in the broadcast feature: Meta's error 131050 on a send or a delivery receipt (the person stopped
// marketing messages), and a STOP-style reply on the inbound webhook (platforms/whatsapp/optOutKeywords.ts, the whole message
// must be the keyword). Both write the HASH-ONLY suppression row (whatsapp_opt_outs: no number, no name, no link to a contact) and
// flip the stored contact to opted out. The row survives erasing the contact, and the database refuses to ever subscribe that key
// again (migration 0128 triggers; whatsappContacts.addContacts checks first for a clear answer).
//
// Nothing here logs a number, a name or a message.

import { supabase } from "../supabase.js";
import { contactKeyFor, contactHashKey, maskPhone } from "../platforms/whatsapp/contactPrivacy.js";
import { optOutKeywordOf } from "../platforms/whatsapp/optOutKeywords.js";

export interface OptOutCause {
  scope: "all" | "marketing";
  source: "meta_131050" | "keyword";
  keyword?: string;
}

interface ContactKeys {
  contact_key: string;
  wa_contact_key?: string | null;
}

const fail = (what: string, error: { message: string }): never => {
  throw new Error(`${what}: ${error.message}`);
};

/** Opts a stored contact out. False when the contact is not this account's. */
export async function recordOptOutForContact(accountId: string, contactId: string, cause: OptOutCause, now: Date = new Date()): Promise<boolean> {
  const found = await supabase.from("whatsapp_contacts").select("id, contact_key, wa_contact_key, contact_display").eq("id", contactId).eq("account_id", accountId).maybeSingle();
  if (found.error) fail("contact lookup failed", found.error);
  const contact = found.data as { id: string; contact_key: string; wa_contact_key: string | null; contact_display: string } | null;
  if (!contact) return false;
  const at = now.toISOString();
  const ins = await supabase.from("whatsapp_opt_outs").upsert(
    { account_id: accountId, contact_key: contact.contact_key, contact_display: contact.contact_display, wa_contact_key: contact.wa_contact_key, scope: cause.scope, source: cause.source, keyword: cause.keyword ?? null, occurred_at: at },
    { onConflict: "account_id,contact_key,scope", ignoreDuplicates: true },
  );
  if (ins.error) fail("opt-out insert failed", ins.error);
  const upd = await supabase.from("whatsapp_contacts").update({ consent_status: "opted_out", opted_out_at: at, updated_at: at }).eq("id", contactId).eq("account_id", accountId);
  if (upd.error) fail("contact update failed", upd.error);
  return true;
}

/** True when any opt-out of this account matches the contact by either key, in either direction (the same rule as the database). */
export async function isSuppressed(accountId: string, contact: ContactKeys): Promise<boolean> {
  const keys = [contact.contact_key, contact.wa_contact_key].filter((k): k is string => typeof k === "string" && k !== "");
  for (const column of ["contact_key", "wa_contact_key"] as const) {
    const { data, error } = await supabase.from("whatsapp_opt_outs").select("id").eq("account_id", accountId).in(column, keys).limit(1);
    if (error) fail("opt-out lookup failed", error);
    if (((data as unknown[] | null) ?? []).length > 0) return true;
  }
  return false;
}

export interface InboundText {
  /** The sender's WhatsApp id (digits). Used in memory only. */
  from: string;
  text: string;
}

/** Handles the inbound texts of one verified delivery: every message that is exactly an opt-out keyword opts that number out.
 *  Returns how many opt-out messages were handled. Without the contact hash key nothing is written. */
export async function recordInboundOptOuts(account: { id: string; account_id: string }, messages: InboundText[], now: Date = new Date()): Promise<number> {
  if (!contactHashKey()) return 0;
  let handled = 0;
  const seen = new Set<string>();
  for (const m of messages) {
    const keyword = optOutKeywordOf(m.text);
    if (!keyword) continue;
    const key = contactKeyFor(account.account_id, m.from);
    if (!key) continue;
    handled += 1;
    if (seen.has(key)) continue;
    seen.add(key);

    let contactId: string | null = null;
    for (const column of ["contact_key", "wa_contact_key"] as const) {
      const { data, error } = await supabase.from("whatsapp_contacts").select("id").eq("account_id", account.account_id).eq(column, key).limit(1);
      if (error) fail("contact lookup failed", error);
      const row = ((data as Array<{ id: string }> | null) ?? [])[0];
      if (row) {
        contactId = row.id;
        break;
      }
    }
    if (contactId) {
      await recordOptOutForContact(account.account_id, contactId, { scope: "all", source: "keyword", keyword }, now);
    } else {
      // Not a stored contact (yet): keep the suppression anyway, so a later import of this number is blocked.
      const ins = await supabase.from("whatsapp_opt_outs").upsert(
        { account_id: account.account_id, contact_key: key, contact_display: maskPhone(m.from), wa_contact_key: null, scope: "all", source: "keyword", keyword, occurred_at: now.toISOString() },
        { onConflict: "account_id,contact_key,scope", ignoreDuplicates: true },
      );
      if (ins.error) fail("opt-out insert failed", ins.error);
    }
  }
  return handled;
}
