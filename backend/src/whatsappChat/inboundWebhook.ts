// The inbound chat path of the WhatsApp webhook. handleWhatsAppWebhookEvent (http/whatsappWebhooks.ts) calls this AFTER it has
// answered 200, with the same raw body, next to the older text-only handler and the receipts handler. It does nothing unless the
// feature is on (WHATSAPP_BYOK_ENABLED, WHATSAPP_BROADCASTS_ENABLED and WHATSAPP_SEND_ENABLED) and both contact keys exist.
//
// Protection is the same as the other handlers: the delivery is verified over the RAW body with THAT connection's own app secret
// (X-Hub-Signature-256) before anything is stored; both Meta ids must match one connected row; a plan that is not paid, a missing
// app secret or a bad signature store nothing. Idempotent: a repeated delivery is a no-op (recordInboundChat).

import { checkWhatsappPlan } from "../accountLimits.js";
import { contactStorageReady } from "../whatsappContacts.js";
import { sendEnabled } from "../whatsappBroadcast/flags.js";
import { connectionsFor, makeVerifier } from "../whatsappBroadcast/webhookAuth.js";
import { extractChatMessages, recordInboundChat, type InboundChat } from "./inbound.js";

export interface ChatEventSummary {
  messages: number;
  stored: number;
  duplicates: number;
  unmatched: number;
  blocked: number;
  rejected: number;
}

export async function processWhatsAppChatEvent(rawBody: Buffer, signatureHeader: string, now: Date = new Date()): Promise<ChatEventSummary> {
  const summary: ChatEventSummary = { messages: 0, stored: 0, duplicates: 0, unmatched: 0, blocked: 0, rejected: 0 };
  if (!sendEnabled() || !contactStorageReady()) return summary;

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return summary;
  }
  const { messages } = extractChatMessages(payload, now);
  summary.messages = messages.length;
  if (messages.length === 0) return summary;

  // The older text-only handler already counts a bad signature on a delivery of plain text; only count here what it never sees.
  const verify = makeVerifier(rawBody, signatureHeader, { recordBad: messages.some((m) => m.kind !== "text") });
  const groups = new Map<string, InboundChat[]>();
  for (const m of messages) groups.set(`${m.wabaId}:${m.phoneNumberId}`, [...(groups.get(`${m.wabaId}:${m.phoneNumberId}`) ?? []), m]);

  const planOk = new Map<string, boolean>();
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
      if (!planOk.has(account.account_id)) planOk.set(account.account_id, (await checkWhatsappPlan(account.account_id)) === null);
      if (!planOk.get(account.account_id)) {
        summary.blocked += group.length;
        continue;
      }
      const result = await recordInboundChat({ id: account.id, account_id: account.account_id }, group, now);
      summary.stored += result.stored;
      summary.duplicates += result.duplicates;
    }
  }
  return summary;
}
