// Meta's delivery receipts for broadcast messages (webhook field "messages", value.statuses[]: sent, delivered, read, failed) and the
// account events that pause a number. Called from handleWhatsAppWebhookEvent (http/whatsappWebhooks.ts) AFTER the 200 answer, with
// the same raw body the inbound handler gets.
//
// What protects it is the same as the inbound path: EVERY customer brings their own Meta app, so a delivery is verified over the RAW
// body with THAT connection's own app secret (X-Hub-Signature-256), read from their Vault entry, in constant time. No saved
// secret, or a signature that does not match: dropped, nothing stored. Both ids (WABA and phone number id) must match one connected
// row; they only route, the signature is the gate.
//
// Meta re-delivers receipts for up to 7 days and does not promise order. So applying one is idempotent and monotonic: a recipient
// only moves forward (handed_off -> sent -> delivered -> read), a repeated receipt changes nothing, and the append-only event row
// is keyed by a keyed hash of (message id, status, Meta's timestamp) so a repeat is not stored twice. A failure never overwrites a
// delivery. A receipt can only touch a recipient of the same account, found by the keyed hash of Meta's message id (the id itself
// embeds the recipient's number and is never stored). A message that is not a broadcast message is ignored.
//
// "delivered" is shown to the customer ONLY from these receipts. A failed receipt is never re-queued (the send was accepted; we
// cannot know it is safe to send again).
//
// Nothing here logs a number, a message id, a name or Meta's error text.

import { supabase } from "../supabase.js";
import { connectionsFor, makeVerifier, type ConnectionRow } from "./webhookAuth.js";
import { META_ID_PATTERN } from "../platforms/whatsapp/credentials.js";
import { contactHashKey, messageKeyFor } from "../platforms/whatsapp/contactPrivacy.js";
import { broadcastsEnabled } from "./flags.js";
import { pauseConnection } from "./connectionPause.js";
import { classifyMetaFailure, type PauseReason } from "./metaErrors.js";
import { recordOptOutForContact, recordOptOutForKey } from "./optOuts.js";
import { refreshCounts } from "./broadcasts.js";

export interface StatusSummary {
  statuses: number;
  applied: number;
  unmatched: number;
  rejected: number;
  blocked: number;
  paused: number;
}

type ReceiptStatus = "sent" | "delivered" | "read" | "failed";
interface Receipt {
  wabaId: string;
  phoneNumberId: string;
  wamid: string;
  status: ReceiptStatus;
  at: Date;
  errorCode: number | null;
  pricingCategory: string | null;
  billable: boolean | null;
}
interface AccountEvent {
  wabaId: string;
  pause: PauseReason;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const WAMID_PATTERN = /^[A-Za-z0-9._=+/-]{5,300}$/;
const RANK: Record<string, number> = { queued: 0, claimed: 0, handed_off: 1, sent: 2, delivered: 3, read: 4 };

// Account events. Known-bad events pause the number; an unrecognised event under these fields is ignored (a restricted number
// also fails its next send with a code that pauses it). The names are as understood on 2026-10-16 and were NOT checked against a
// live account.
const QUALITY_EVENTS = new Set(["FLAGGED", "DOWNGRADE"]);
const RESTRICTION_EVENTS = new Set(["DISABLED_UPDATE", "ACCOUNT_VIOLATION", "ACCOUNT_RESTRICTION", "ACCOUNT_DELETED", "ACCOUNT_BANNED"]);

export function extractReceipts(payload: unknown, now: Date): { receipts: Receipt[]; events: AccountEvent[] } {
  const receipts: Receipt[] = [];
  const events: AccountEvent[] = [];
  if (!isRecord(payload) || payload.object !== "whatsapp_business_account") return { receipts, events };
  for (const entry of asArray(payload.entry)) {
    if (!isRecord(entry)) continue;
    const wabaId = typeof entry.id === "string" ? entry.id : typeof entry.id === "number" ? String(entry.id) : null;
    if (!wabaId || !META_ID_PATTERN.test(wabaId)) continue;
    for (const change of asArray(entry.changes)) {
      if (!isRecord(change) || !isRecord(change.value)) continue;
      const value = change.value;
      if (change.field === "messages") {
        const phone = isRecord(value.metadata) ? value.metadata.phone_number_id : null;
        const phoneNumberId = typeof phone === "string" ? phone : typeof phone === "number" ? String(phone) : null;
        if (!phoneNumberId || !META_ID_PATTERN.test(phoneNumberId)) continue;
        for (const s of asArray(value.statuses)) {
          if (!isRecord(s)) continue;
          const id = typeof s.id === "string" ? s.id : null;
          const st = typeof s.status === "string" ? s.status : null;
          if (!id || !WAMID_PATTERN.test(id) || (st !== "sent" && st !== "delivered" && st !== "read" && st !== "failed")) continue;
          const seconds = Number(typeof s.timestamp === "string" || typeof s.timestamp === "number" ? s.timestamp : NaN);
          const at = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : now;
          const firstError = asArray(s.errors).find(isRecord);
          const code = firstError && typeof firstError.code === "number" ? firstError.code : null;
          const pricing = isRecord(s.pricing) ? s.pricing : null;
          const category = pricing && typeof pricing.category === "string" && /^[a-z_]{1,40}$/.test(pricing.category) ? pricing.category : null;
          receipts.push({ wabaId, phoneNumberId, wamid: id, status: st, at, errorCode: code, pricingCategory: category, billable: pricing && typeof pricing.billable === "boolean" ? pricing.billable : null });
        }
      } else if (change.field === "phone_number_quality_update" || change.field === "account_update") {
        const event = typeof value.event === "string" ? value.event.toUpperCase() : "";
        if (change.field === "phone_number_quality_update" && QUALITY_EVENTS.has(event)) events.push({ wabaId, pause: "quality" });
        else if (change.field === "account_update" && RESTRICTION_EVENTS.has(event)) events.push({ wabaId, pause: "restricted" });
      }
    }
  }
  return { receipts, events };
}

export async function processWhatsAppStatusEvent(rawBody: Buffer, signatureHeader: string, now: Date = new Date()): Promise<StatusSummary> {
  const summary: StatusSummary = { statuses: 0, applied: 0, unmatched: 0, rejected: 0, blocked: 0, paused: 0 };
  if (!broadcastsEnabled() || !contactHashKey()) return summary;

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return summary;
  }
  const { receipts, events } = extractReceipts(payload, now);
  summary.statuses = receipts.length;
  if (receipts.length === 0 && events.length === 0) return summary;

  const verify = makeVerifier(rawBody, signatureHeader);

  // Receipts, grouped by (WABA id, phone number id).
  const groups = new Map<string, Receipt[]>();
  for (const r of receipts) groups.set(`${r.wabaId}:${r.phoneNumberId}`, [...(groups.get(`${r.wabaId}:${r.phoneNumberId}`) ?? []), r]);
  for (const group of groups.values()) {
    const accounts = await connectionsFor(group[0].wabaId, group[0].phoneNumberId);
    if (accounts.length === 0) {
      summary.unmatched += group.length;
      continue;
    }
    for (const account of accounts) {
      const ok = await verify(account);
      if (ok === "blocked") {
        summary.blocked += group.length;
        continue;
      }
      if (!ok) {
        summary.rejected += group.length;
        continue;
      }
      const touched = new Set<string>();
      for (const r of group) {
        const result = await applyReceipt(account, r, now);
        if (result === "unmatched") summary.unmatched += 1;
        else if (result.applied) {
          summary.applied += 1;
          if (result.broadcastId) touched.add(result.broadcastId);
        }
      }
      for (const id of touched) await refreshCounts(id);
    }
  }

  // Account events: matched by business account id only (Meta does not name the phone number id here).
  for (const e of events) {
    for (const account of await connectionsFor(e.wabaId, null)) {
      if ((await verify(account)) !== true) continue;
      await pauseConnection(account.account_id, account.id, e.pause, null, now);
      summary.paused += 1;
    }
  }
  return summary;
}

interface RecipientRow {
  id: string;
  broadcast_id: string;
  contact_id: string;
  status: string;
}

async function applyReceipt(account: ConnectionRow, r: Receipt, now: Date): Promise<"unmatched" | { applied: boolean; broadcastId: string | null }> {
  const messageKey = messageKeyFor(account.account_id, r.wamid);
  const eventKey = messageKeyFor(account.account_id, `${r.wamid}|${r.status}|${r.at.getTime()}`);
  if (!messageKey || !eventKey) return "unmatched";

  const { data, error } = await supabase.from("whatsapp_broadcast_recipients").select("id, broadcast_id, contact_id, status").eq("account_id", account.account_id).eq("message_key", messageKey).maybeSingle();
  if (error) throw new Error("recipient lookup failed");
  const recipient = data as RecipientRow | null;
  // Not a broadcast message: it may be a message sent from a chat conversation (whatsappChat/chatSend.ts).
  if (!recipient) return applyChatReceipt(account, r, messageKey, now);

  // The append-only record. A repeat of the same receipt has the same key and is not stored twice.
  const ev = await supabase.from("whatsapp_broadcast_status_events").upsert(
    {
      account_id: account.account_id,
      social_account_id: account.id,
      broadcast_recipient_id: recipient.id,
      event_key: eventKey,
      status: r.status,
      event_at: r.at.toISOString(),
      error_code: r.errorCode,
      pricing_category: r.pricingCategory,
      billable: r.billable,
    },
    { onConflict: "event_key", ignoreDuplicates: true },
  );
  if (ev.error) throw new Error("status event save failed");

  const at = r.at.toISOString();
  const current = RANK[recipient.status];
  const stamp = now.toISOString();

  if (r.status !== "failed") {
    const target = RANK[r.status];
    // Only forward, and only for a recipient that Meta accepted (a failed or skipped one stays that way).
    if (current === undefined || current === 0 || target <= current) return { applied: false, broadcastId: recipient.broadcast_id };
    const patch: Record<string, unknown> = { status: r.status, updated_at: stamp };
    patch[`${r.status}_at`] = at;
    const upd = await supabase.from("whatsapp_broadcast_recipients").update(patch).eq("id", recipient.id).eq("status", recipient.status);
    if (upd.error) throw new Error("recipient update failed");
    return { applied: true, broadcastId: recipient.broadcast_id };
  }

  // A failure never overwrites a delivery, and a repeat of a failure changes nothing.
  if (current === undefined || current >= RANK.delivered) return { applied: false, broadcastId: recipient.broadcast_id };
  const action = r.errorCode === null ? null : classifyMetaFailure({ code: r.errorCode });
  let reason = "delivery_failed";
  if (action?.kind === "opt_out") {
    await recordOptOutForContact(account.account_id, recipient.contact_id, { scope: "marketing", source: "meta_131050" }, now);
    reason = action.reason;
  } else if (action?.kind === "pause_connection") {
    await pauseConnection(account.account_id, account.id, action.pause, r.errorCode, now);
    reason = action.reason;
  } else if (action?.kind === "pause_broadcast") {
    await supabase.from("whatsapp_broadcasts").update({ status: "paused", pause_reason: action.reason, updated_at: stamp }).eq("id", recipient.broadcast_id).eq("status", "sending");
    reason = action.reason;
  } else if (action?.kind === "retry" || action?.kind === "recipient_failed") {
    reason = action.kind === "retry" ? "delivery_failed_transient" : action.reason;
  }
  const upd = await supabase
    .from("whatsapp_broadcast_recipients")
    .update({ status: "failed", failure_reason: reason, error_code: r.errorCode, failed_at: at, updated_at: stamp })
    .eq("id", recipient.id)
    .eq("status", recipient.status);
  if (upd.error) throw new Error("recipient update failed");
  return { applied: true, broadcastId: recipient.broadcast_id };
}

interface ChatMessageRow {
  id: string;
  conversation_id: string;
  status: string;
}

/** The same rules for a message sent from a chat conversation: forward only, a failure never overwrites a delivery, 131050 opts the
 *  person out, a restriction code pauses the connection. No event row (the table is keyed to broadcast recipients); applying a
 *  receipt is idempotent on its own. */
async function applyChatReceipt(account: ConnectionRow, r: Receipt, messageKey: string, now: Date): Promise<"unmatched" | { applied: boolean; broadcastId: null }> {
  const { data, error } = await supabase.from("whatsapp_chat_messages").select("id, conversation_id, status").eq("account_id", account.account_id).eq("message_key", messageKey).eq("direction", "outbound").maybeSingle();
  if (error) throw new Error("chat message lookup failed");
  const message = data as ChatMessageRow | null;
  if (!message) return "unmatched";
  const none = { applied: false, broadcastId: null } as const;
  const current = RANK[message.status];
  const at = r.at.toISOString();

  if (r.status !== "failed") {
    if (current === undefined || current === 0 || RANK[r.status] <= current) return none;
    const patch: Record<string, unknown> = { status: r.status };
    patch[`${r.status}_at`] = at;
    const upd = await supabase.from("whatsapp_chat_messages").update(patch).eq("id", message.id).eq("status", message.status);
    if (upd.error) throw new Error("chat message update failed");
    return { applied: true, broadcastId: null };
  }

  if (current === undefined || current >= RANK.delivered) return none;
  const action = r.errorCode === null ? null : classifyMetaFailure({ code: r.errorCode });
  let reason = "delivery_failed";
  if (action?.kind === "opt_out") {
    const conv = await supabase.from("whatsapp_conversations").select("id, contact_id, contact_key, contact_display").eq("id", message.conversation_id).eq("account_id", account.account_id).maybeSingle();
    if (conv.error) throw new Error("conversation lookup failed");
    const c = conv.data as { contact_id: string | null; contact_key: string; contact_display: string } | null;
    if (c?.contact_id) await recordOptOutForContact(account.account_id, c.contact_id, { scope: "marketing", source: "meta_131050" }, now);
    else if (c) await recordOptOutForKey(account.account_id, c.contact_key, c.contact_display, { scope: "marketing", source: "meta_131050" }, now);
    reason = action.reason;
  } else if (action?.kind === "pause_connection") {
    await pauseConnection(account.account_id, account.id, action.pause, r.errorCode, now);
    reason = action.reason;
  } else if (action?.kind === "pause_broadcast") {
    reason = action.reason;
  } else if (action?.kind === "retry" || action?.kind === "recipient_failed") {
    reason = action.kind === "retry" ? "delivery_failed_transient" : action.reason;
  }
  const upd = await supabase.from("whatsapp_chat_messages").update({ status: "failed", failure_reason: reason, error_code: r.errorCode, failed_at: at }).eq("id", message.id).eq("status", message.status);
  if (upd.error) throw new Error("chat message update failed");
  return { applied: true, broadcastId: null };
}
