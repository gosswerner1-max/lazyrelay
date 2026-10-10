import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { supabase } from "../supabase.js";
import { triageItems, type TriageItem } from "../commentTriage.js";
import { checkWhatsappPlan } from "../accountLimits.js";
import { META_ID_PATTERN } from "../platforms/whatsapp/credentials.js";

// WhatsApp (bring your own key), real-time inbound messages. Mounted in app.ts at /api/webhooks/whatsapp, OUTSIDE the
// dashboard's authorization: Meta's servers call it, not a signed-in person. What protects it instead:
//
//   GET  the one-time handshake. Meta sends hub.mode, hub.verify_token and hub.challenge; the token must equal
//        WHATSAPP_WEBHOOK_VERIFY_TOKEN (timing-safe) and the challenge is echoed back as plain text.
//   POST real deliveries. Meta signs the RAW body with the app secret (X-Hub-Signature-256: sha256=<hex hmac>); it is
//        checked against WHATSAPP_APP_SECRET before anything else happens, and a bad signature gets 403. Without that
//        check anyone who knows a phone number id (an identifier, not a secret) could forge messages into a customer's
//        inbox and run up LazyRelay's AI bill. A valid delivery is answered 200 "EVENT_RECEIVED" at once (Meta retries
//        anything slower and floods on failure) and processed after the response.
//
// Both are dormant (404) unless WHATSAPP_BYOK_ENABLED=true, like every other part of the feature.
//
// KNOWN LIMIT, STATED PLAINLY: one global WHATSAPP_APP_SECRET verifies deliveries from ONE Meta app. A customer who
// brings their own Meta app signs with THEIR app secret, which LazyRelay does not hold. Until per-account app secrets
// exist (a field at connect time, kept in Vault), this only verifies deliveries from an app LazyRelay controls.
//
// WHAT HAPPENS TO A MESSAGE. WhatsApp inbound text is a direct message, not a comment on a post, so it goes where every
// other direct message goes: dm_conversations_cache (one row per contact, newest message as the snippet; the 30 day
// purge of migration 0117 already covers it) and a triage verdict in comment_triage via triageItems (item type "dm").
// There is no separate "mentions" table: a new one would keep a stranger's phone number and message text with no
// retention. Fail closed everywhere: a WABA id plus phone number id that matches no connected, active WhatsApp row, an
// account whose own keys are out of credit, a paused row or a plan below Business stores nothing and costs nothing.
//
// Message text, names and phone numbers are never logged.

const VERIFY_TOKEN_ENV = "WHATSAPP_WEBHOOK_VERIFY_TOKEN";
const APP_SECRET_ENV = "WHATSAPP_APP_SECRET";
const MAX_CHALLENGE_LENGTH = 256;
/** A delivery can batch many messages; this bounds the work (and the AI batches) one delivery can cause. */
const MAX_MESSAGES_PER_DELIVERY = 200;
/** WhatsApp text is at most 4096 characters; the stored snippet and the triage input stop here (same ceiling the reply
 *  drafting prompt uses for a comment), which also bounds the AI cost of one message. */
const MAX_TEXT_CHARS = 1000;
const MAX_NAME_CHARS = 80;
const WA_ID_PATTERN = /^[0-9]{5,20}$/;

const featureOn = (): boolean => process.env.WHATSAPP_BYOK_ENABLED === "true";

function safeEqual(a: string, b: string): boolean {
  return Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------------------------------------------------------- GET: the handshake

export function verifyWhatsAppWebhook(req: Request, res: Response): void {
  if (!featureOn()) {
    res.status(404).end();
    return;
  }
  const expectedToken = process.env[VERIFY_TOKEN_ENV];
  if (!expectedToken) {
    console.error(`${VERIFY_TOKEN_ENV} is not set -- refusing the WhatsApp webhook verification handshake.`);
    res.status(500).end();
    return;
  }
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode !== "subscribe" || typeof token !== "string" || !safeEqual(token, expectedToken) || typeof challenge !== "string" || challenge.length === 0 || challenge.length > MAX_CHALLENGE_LENGTH) {
    res.status(403).end();
    return;
  }
  // text/plain: the challenge is echoed back verbatim and must never be interpreted as markup.
  res.status(200).type("text/plain").send(challenge);
}

// ---------------------------------------------------------------- POST: the deliveries

/** Work started after the response. Kept so a test (or a graceful shutdown) can wait for it. */
const inflight = new Set<Promise<unknown>>();
export async function whatsAppWebhookIdle(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

export function handleWhatsAppWebhookEvent(req: Request, res: Response): void {
  if (!featureOn()) {
    res.status(404).end();
    return;
  }
  const appSecret = process.env[APP_SECRET_ENV];
  if (!appSecret) {
    console.error(`${APP_SECRET_ENV} is not set -- refusing an unverifiable WhatsApp webhook delivery.`);
    res.status(500).end();
    return;
  }
  // express.raw() in app.ts: the HMAC is over the exact bytes Meta sent. Anything else (wrong content type) is empty and
  // cannot match.
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
  const signatureHeader = req.header("X-Hub-Signature-256") ?? "";
  const expectedSignature = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  if (!safeEqual(signatureHeader, expectedSignature)) {
    console.error("WhatsApp webhook signature verification failed.");
    res.status(403).end();
    return;
  }

  // Meta needs the answer within seconds and retries a slow or failing endpoint, so answer first.
  res.status(200).type("text/plain").send("EVENT_RECEIVED");

  const work = processWhatsAppEvent(rawBody)
    .then((s) => console.log(`[whatsapp-webhook] processed: messages=${s.messages} stored=${s.stored} unmatched=${s.unmatched} blocked=${s.blocked}`))
    // The error message only: it never carries the payload.
    .catch((err) => console.error("[whatsapp-webhook] processing failed:", err instanceof Error ? err.message : "unknown error"))
    .finally(() => inflight.delete(work));
  inflight.add(work);
}

// ---------------------------------------------------------------- parsing

export interface WhatsAppTextMessage {
  /** The WhatsApp Business Account id (entry.id). */
  wabaId: string;
  /** metadata.phone_number_id: which of the business's numbers received it. */
  phoneNumberId: string;
  /** The sender's WhatsApp id (their phone number, digits only). */
  from: string;
  /** The sender's profile name, when Meta sent one. */
  name: string | null;
  text: string;
  at: Date;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

/** Pulls the plain text messages out of a delivery (entry[].changes[].value.messages[]). Everything else in a delivery
 *  (delivery receipts, reactions, media, templates, unknown types) is skipped. Never throws. */
export function extractWhatsAppTextMessages(payload: unknown, now: Date = new Date()): { messages: WhatsAppTextMessage[]; skipped: number } {
  const out: WhatsAppTextMessage[] = [];
  let skipped = 0;
  if (!isRecord(payload) || payload.object !== "whatsapp_business_account") return { messages: out, skipped };

  for (const entry of asArray(payload.entry)) {
    if (!isRecord(entry)) continue;
    const wabaId = asString(entry.id);
    for (const change of asArray(entry.changes)) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) continue;
      const value = change.value;
      const phoneNumberId = isRecord(value.metadata) ? asString(value.metadata.phone_number_id) : null;
      if (!wabaId || !phoneNumberId || !META_ID_PATTERN.test(wabaId) || !META_ID_PATTERN.test(phoneNumberId)) {
        skipped += asArray(value.messages).length;
        continue;
      }
      const names = new Map<string, string>();
      for (const c of asArray(value.contacts)) {
        if (!isRecord(c)) continue;
        const waId = asString(c.wa_id);
        const name = isRecord(c.profile) ? asString(c.profile.name) : null;
        if (waId && name) names.set(waId, name);
      }
      for (const m of asArray(value.messages)) {
        const from = isRecord(m) ? asString(m.from) : null;
        const body = isRecord(m) && m.type === "text" && isRecord(m.text) ? asString(m.text.body) : null;
        if (!isRecord(m) || !from || !WA_ID_PATTERN.test(from) || body === null || body.trim() === "") {
          skipped += 1;
          continue;
        }
        if (out.length >= MAX_MESSAGES_PER_DELIVERY) {
          skipped += 1;
          continue;
        }
        const seconds = Number(asString(m.timestamp));
        const at = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : now;
        const rawName = names.get(from) ?? null;
        out.push({
          wabaId,
          phoneNumberId,
          from,
          name: rawName ? rawName.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_NAME_CHARS) || null : null,
          text: body.trim().slice(0, MAX_TEXT_CHARS),
          at,
        });
      }
    }
  }
  return { messages: out, skipped };
}

// ---------------------------------------------------------------- processing

export interface WhatsAppEventSummary {
  /** Text messages found in the delivery. */
  messages: number;
  /** Conversations written (one per contact per connected number). */
  stored: number;
  /** Messages for a WABA id + phone number id that matches no connected, active WhatsApp row. */
  unmatched: number;
  /** Messages for a matched row that was refused: out of credit, paused, or a plan below Business. */
  blocked: number;
}

interface WhatsAppAccountRow {
  id: string;
  account_id: string;
  byok_status: string | null;
  paused_at: string | null;
}

/** Whole-second ISO string in the form the database hands back for a timestamptz, so the triage cache signature written
 *  here equals the one the DM list computes later (no second AI call for the same message). */
const signatureOf = (d: Date): string => d.toISOString().slice(0, 19) + "+00:00";

export async function processWhatsAppEvent(rawBody: Buffer): Promise<WhatsAppEventSummary> {
  const summary: WhatsAppEventSummary = { messages: 0, stored: 0, unmatched: 0, blocked: 0 };
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    console.error("[whatsapp-webhook] delivery was not valid JSON despite a valid signature.");
    return summary;
  }
  const { messages } = extractWhatsAppTextMessages(payload);
  summary.messages = messages.length;
  if (messages.length === 0) return summary;

  // One lookup per distinct (WABA id, phone number id) pair in the delivery.
  const byNumber = new Map<string, WhatsAppTextMessage[]>();
  for (const m of messages) {
    const key = `${m.wabaId}:${m.phoneNumberId}`;
    byNumber.set(key, [...(byNumber.get(key) ?? []), m]);
  }
  const planOk = new Map<string, boolean>();

  for (const group of byNumber.values()) {
    const { wabaId, phoneNumberId } = group[0];
    // BOTH ids must match the same connected WhatsApp row. The ids are identifiers, not secrets, which is exactly why
    // the signature above is the real gate and this lookup only routes.
    const { data: rows, error } = await supabase
      .from("social_accounts")
      .select("id, account_id, byok_status, paused_at")
      .eq("platform", "whatsapp")
      .eq("whatsapp_business_account_id", wabaId)
      .eq("whatsapp_phone_number_id", phoneNumberId)
      .is("disconnected_at", null);
    if (error) throw new Error("account lookup failed");
    const accounts = (rows ?? []) as WhatsAppAccountRow[];
    if (accounts.length === 0) {
      summary.unmatched += group.length;
      continue;
    }

    for (const account of accounts) {
      if (account.byok_status === "out_of_credit" || account.paused_at) {
        summary.blocked += group.length;
        continue;
      }
      if (!planOk.has(account.account_id)) planOk.set(account.account_id, (await checkWhatsappPlan(account.account_id)) === null);
      if (!planOk.get(account.account_id)) {
        summary.blocked += group.length;
        continue;
      }
      summary.stored += await storeAndTriage(account, group);
    }
  }
  return summary;
}

/** One conversation per contact: the newest message of this delivery, unless the stored one is already newer (Meta can
 *  deliver out of order or twice; a repeat changes nothing). Returns how many conversations were written. */
async function storeAndTriage(account: WhatsAppAccountRow, group: WhatsAppTextMessage[]): Promise<number> {
  const newest = new Map<string, WhatsAppTextMessage>();
  for (const m of group) {
    const seen = newest.get(m.from);
    if (!seen || m.at > seen.at) newest.set(m.from, m);
  }

  const { data: existing, error } = await supabase
    .from("dm_conversations_cache")
    .select("conversation_id, conversation_updated_at")
    .eq("social_account_id", account.id)
    .in("conversation_id", [...newest.keys()]);
  if (error) throw new Error("conversation lookup failed");
  const storedAt = new Map((existing ?? []).map((r) => [r.conversation_id as string, r.conversation_updated_at ? new Date(r.conversation_updated_at as string) : null]));

  const toTriage: TriageItem[] = [];
  let written = 0;
  const fetchedAt = new Date().toISOString();
  for (const m of newest.values()) {
    const prior = storedAt.get(m.from);
    if (prior && prior >= m.at) continue;
    const { error: upsertError } = await supabase.from("dm_conversations_cache").upsert(
      {
        account_id: account.account_id,
        social_account_id: account.id,
        conversation_id: m.from,
        participant_id: m.from,
        participant_name: m.name ?? "WhatsApp contact",
        snippet: m.text,
        conversation_updated_at: m.at.toISOString(),
        fetched_at: fetchedAt,
      },
      { onConflict: "social_account_id,conversation_id" },
    );
    if (upsertError) throw new Error("conversation write failed");
    written += 1;
    toTriage.push({ itemId: m.from, sourceSignature: signatureOf(m.at), author: m.name ?? "WhatsApp contact", text: m.text });
  }

  if (toTriage.length > 0) {
    try {
      // Writes its verdicts to comment_triage itself. No API key or a failed call leaves the message unclassified, never
      // "routine", and never loses the message that is already stored.
      await triageItems(account.account_id, "dm", toTriage);
    } catch (err) {
      console.error("[whatsapp-webhook] triage failed:", err instanceof Error ? err.message : "unknown error");
    }
  }
  return written;
}
