// Inbound chat (two-way WhatsApp): what a verified delivery contains, and what is stored for it.
//
//   * Every message is kept per conversation (one person talking to one of the customer's numbers). The body is an AES-256-GCM
//     envelope (chatVault.ts), the person's number is an envelope too (a reply cannot be sent to a hash), and Meta's message id is
//     kept only as a keyed hash (it embeds the number). A repeated delivery of the same message is a no-op.
//   * A person who is NOT a stored contact still gets a conversation, so the customer can answer them inside Meta's 24 hour window.
//     They are never added to whatsapp_contacts, never given a consent record, and can never be in a broadcast audience.
//   * A STOP-style message still opts the number out (the same keyword rule and the same hash-only suppression row as everywhere).
//   * A button or list tap that answers one of our approval-request messages is matched to that request and recorded.
//
// Nothing here logs a number, a name or a message.

import { randomUUID } from "node:crypto";
import { supabase } from "../supabase.js";
import { cleanDisplayName } from "../whatsappContacts.js";
import { META_ID_PATTERN } from "../platforms/whatsapp/credentials.js";
import { contactHashKey, contactKeyFor, maskPhone, messageKeyFor } from "../platforms/whatsapp/contactPrivacy.js";
import { encryptPhone } from "../platforms/whatsapp/phoneVault.js";
import { optOutKeywordOf } from "../platforms/whatsapp/optOutKeywords.js";
import { recordInboundOptOuts } from "../whatsappBroadcast/optOuts.js";
import { encryptBody } from "./chatVault.js";
import { matchOption, statusForOption, type ApprovalOption } from "./approvalOptions.js";

export type InboundKind = "text" | "button_reply" | "list_reply" | "unsupported";

export interface InboundChat {
  wabaId: string;
  phoneNumberId: string;
  /** The sender's WhatsApp id (digits). Used in memory only. */
  from: string;
  wamid: string;
  name: string | null;
  at: Date;
  kind: InboundKind;
  text: string;
  /** The id of the message this one answers (Meta's "context" id), when it answers one. */
  contextWamid: string | null;
  interaction: { id: string; title: string } | null;
}

const MAX_TEXT = 4096;
const MAX_NAME = 80;
const WAMID = /^[A-Za-z0-9._=+/-]{5,300}$/;
const WA_ID = /^[0-9]{5,20}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

export function extractChatMessages(payload: unknown, now: Date = new Date()): { messages: InboundChat[]; skipped: number } {
  const messages: InboundChat[] = [];
  let skipped = 0;
  if (!isRecord(payload) || payload.object !== "whatsapp_business_account") return { messages, skipped };
  for (const entry of arr(payload.entry)) {
    if (!isRecord(entry)) continue;
    const wabaId = str(entry.id);
    for (const change of arr(entry.changes)) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) continue;
      const value = change.value;
      const phoneNumberId = isRecord(value.metadata) ? str(value.metadata.phone_number_id) : null;
      if (!wabaId || !phoneNumberId || !META_ID_PATTERN.test(wabaId) || !META_ID_PATTERN.test(phoneNumberId)) {
        skipped += arr(value.messages).length;
        continue;
      }
      const names = new Map<string, string>();
      for (const c of arr(value.contacts)) {
        if (!isRecord(c)) continue;
        const waId = str(c.wa_id);
        const name = isRecord(c.profile) ? str(c.profile.name) : null;
        if (waId && name) names.set(waId, name);
      }
      for (const m of arr(value.messages)) {
        if (!isRecord(m)) {
          skipped += 1;
          continue;
        }
        const from = str(m.from);
        const wamid = str(m.id);
        const type = str(m.type);
        if (!from || !WA_ID.test(from) || !wamid || !WAMID.test(wamid) || !type) {
          skipped += 1;
          continue;
        }
        if (type === "reaction") continue;
        const seconds = Number(str(m.timestamp));
        const at = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : now;
        const context = isRecord(m.context) ? str(m.context.id) : null;
        const contextWamid = context && WAMID.test(context) ? context : null;
        const rawName = names.get(from) ?? null;
        const name = rawName ? rawName.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_NAME) || null : null;
        const base = { wabaId, phoneNumberId, from, wamid, name, at, contextWamid };

        let kind: InboundKind = "unsupported";
        let body = `[${/^[a-z_]{1,30}$/.test(type) ? type : "unknown"} message: open WhatsApp to view it]`;
        let interaction: InboundChat["interaction"] = null;
        if (type === "text" && isRecord(m.text)) {
          const t = str(m.text.body)?.trim() ?? "";
          if (t === "") {
            skipped += 1;
            continue;
          }
          kind = "text";
          body = t.slice(0, MAX_TEXT);
        } else if (type === "interactive" && isRecord(m.interactive)) {
          const i = m.interactive;
          const reply = i.type === "button_reply" && isRecord(i.button_reply) ? i.button_reply : i.type === "list_reply" && isRecord(i.list_reply) ? i.list_reply : null;
          const id = reply ? str(reply.id) : null;
          const title = reply ? str(reply.title) : null;
          if (!reply || !id || title === null) {
            skipped += 1;
            continue;
          }
          kind = i.type === "button_reply" ? "button_reply" : "list_reply";
          body = title.slice(0, 200);
          interaction = { id: id.slice(0, 256), title: body };
        } else if (type === "button" && isRecord(m.button)) {
          // a tap on a quick-reply button of a TEMPLATE message
          const t = str(m.button.text);
          if (t === null) {
            skipped += 1;
            continue;
          }
          kind = "button_reply";
          body = t.slice(0, 200);
          interaction = { id: (str(m.button.payload) ?? t).slice(0, 256), title: body };
        }
        messages.push({ ...base, kind, text: body, interaction });
      }
    }
  }
  return { messages, skipped };
}

// ---------------------------------------------------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------------------------------------------------

export interface InboundSummary {
  stored: number;
  duplicates: number;
}

const fail = (what: string, error: { message: string }): never => {
  throw new Error(`${what}: ${error.message}`);
};

interface ConversationRow {
  id: string;
  unread_count: number;
  last_inbound_at: string | null;
}

async function findOrCreateConversation(account: { id: string; account_id: string }, m: InboundChat, contactKey: string, now: Date): Promise<ConversationRow> {
  const find = async () => {
    const { data, error } = await supabase.from("whatsapp_conversations").select("id, unread_count, last_inbound_at").eq("account_id", account.account_id).eq("social_account_id", account.id).eq("contact_key", contactKey).maybeSingle();
    if (error) fail("conversation lookup failed", error);
    return (data as ConversationRow | null) ?? null;
  };
  const existing = await find();
  if (existing) return existing;

  // A stored contact of this connection, if there is one (never created here).
  const c = await supabase.from("whatsapp_contacts").select("id").eq("account_id", account.account_id).eq("social_account_id", account.id).eq("contact_key", contactKey).maybeSingle();
  if (c.error) fail("contact lookup failed", c.error);
  const contactId = (c.data as { id: string } | null)?.id ?? null;
  const name = cleanDisplayName(m.name);
  const at = now.toISOString();
  const row = {
    id: randomUUID(),
    account_id: account.account_id,
    social_account_id: account.id,
    contact_key: contactKey,
    contact_display: maskPhone(m.from),
    contact_id: contactId,
    phone_ciphertext: encryptPhone(account.account_id, contactKey, `+${m.from}`),
    display_name: name.ok ? name.value : null,
    last_inbound_at: null,
    last_message_at: m.at.toISOString(),
    unread_count: 0,
    created_at: at,
    updated_at: at,
  };
  const ins = await supabase.from("whatsapp_conversations").insert(row);
  if (ins.error) {
    // Two deliveries creating the same conversation at once: the other one won; use it.
    const raced = await find();
    if (raced) return raced;
    fail("conversation save failed", ins.error);
  }
  return { id: row.id, unread_count: 0, last_inbound_at: null };
}

/** Stores the verified inbound messages of one connection. Returns how many were new. With no contact hash key nothing is stored;
 *  with no encryption key it throws (nothing is stored in the clear). */
export async function recordInboundChat(account: { id: string; account_id: string }, messages: InboundChat[], now: Date = new Date()): Promise<InboundSummary> {
  const out: InboundSummary = { stored: 0, duplicates: 0 };
  if (!contactHashKey()) return out;
  for (const m of messages) {
    const contactKey = contactKeyFor(account.account_id, m.from);
    const messageKey = messageKeyFor(account.account_id, m.wamid);
    if (!contactKey || !messageKey) continue;

    const dup = await supabase.from("whatsapp_chat_messages").select("id").eq("account_id", account.account_id).eq("message_key", messageKey).maybeSingle();
    if (dup.error) fail("message lookup failed", dup.error);
    if (dup.data) {
      out.duplicates += 1;
      continue;
    }

    const conversation = await findOrCreateConversation(account, m, contactKey, now);
    const messageId = randomUUID();
    const at = m.at.toISOString();
    const ins = await supabase.from("whatsapp_chat_messages").insert({
      id: messageId,
      account_id: account.account_id,
      conversation_id: conversation.id,
      direction: "inbound",
      kind: m.kind,
      body_ciphertext: encryptBody(account.account_id, conversation.id, m.text),
      message_key: messageKey,
      status: "received",
      reply_to_message_key: m.contextWamid ? messageKeyFor(account.account_id, m.contextWamid) : null,
      occurred_at: at,
      created_at: now.toISOString(),
    });
    if (ins.error) fail("message save failed", ins.error);
    out.stored += 1;

    const newest = !conversation.last_inbound_at || new Date(conversation.last_inbound_at).getTime() < m.at.getTime() ? at : conversation.last_inbound_at;
    const upd = await supabase
      .from("whatsapp_conversations")
      .update({ last_inbound_at: newest, last_message_at: newest, unread_count: conversation.unread_count + 1, updated_at: now.toISOString() })
      .eq("id", conversation.id);
    if (upd.error) fail("conversation update failed", upd.error);

    // A STOP-style message opts the number out, even though the same delivery was already offered to the inbound handler.
    if (m.kind === "text" && optOutKeywordOf(m.text)) await recordInboundOptOuts(account, [{ from: m.from, text: m.text }], now);

    if (m.interaction && m.contextWamid) await recordApprovalAnswer(account.account_id, m, messageKey, messageId, now);
  }
  return out;
}

/** Matches a tap to the approval request whose outgoing message it answers. Only the same account's request is touched. */
async function recordApprovalAnswer(accountId: string, m: InboundChat, _replyMessageKey: string, replyMessageId: string, now: Date): Promise<void> {
  const contextKey = messageKeyFor(accountId, m.contextWamid!);
  if (!contextKey || !m.interaction) return;
  const out = await supabase.from("whatsapp_chat_messages").select("id").eq("account_id", accountId).eq("message_key", contextKey).eq("direction", "outbound").maybeSingle();
  if (out.error) fail("approval message lookup failed", out.error);
  const sent = out.data as { id: string } | null;
  if (!sent) return;
  const found = await supabase.from("whatsapp_approval_requests").select("id, options").eq("account_id", accountId).eq("message_id", sent.id).maybeSingle();
  if (found.error) fail("approval lookup failed", found.error);
  const request = found.data as { id: string; options: ApprovalOption[] } | null;
  if (!request) return;
  const option = matchOption(Array.isArray(request.options) ? request.options : [], m.interaction);
  const upd = await supabase
    .from("whatsapp_approval_requests")
    .update({
      status: option ? statusForOption(option.id) : "other_reply",
      response_option_id: option ? option.id : m.interaction.id.slice(0, 256),
      response_title: m.interaction.title.slice(0, 60),
      responded_at: m.at.toISOString(),
      response_message_id: replyMessageId,
      updated_at: now.toISOString(),
    })
    .eq("id", request.id)
    .eq("account_id", accountId);
  if (upd.error) fail("approval update failed", upd.error);
}
