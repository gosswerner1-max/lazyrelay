import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { supabase } from "../supabase.js";
import { classifyUntrustedMessages, sanitizeUntrustedMessage, MAX_ITEMS_PER_BATCH, type TriageItem, type TriageResult } from "../commentTriage.js";
import { checkWhatsappPlan } from "../accountLimits.js";
import { META_ID_PATTERN, parseWhatsAppBundle } from "../platforms/whatsapp/credentials.js";
import { contactHashKey, contactKeyFor, maskPhone, messageKeyFor } from "../platforms/whatsapp/contactPrivacy.js";
import { recordSecurityEvent } from "./securityAlerts.js";

// WhatsApp (bring your own key), real-time inbound messages. Mounted in app.ts at /api/webhooks/whatsapp, OUTSIDE the
// dashboard's authorization: Meta's servers call it, not a signed-in person. What protects it instead:
//
//   GET  the one-time handshake. Meta sends hub.mode, hub.verify_token and hub.challenge; the token must equal
//        WHATSAPP_WEBHOOK_VERIFY_TOKEN (timing-safe) and the challenge is echoed back as plain text.
//   POST real deliveries. EVERY customer brings their OWN Meta app, and Meta signs each delivery with THAT app's secret
//        (X-Hub-Signature-256: sha256=<hex hmac of the raw body>). So the secret that proves a delivery is genuine is not
//        a server setting: it is the customer's App Secret, kept in their Vault entry next to their token. The order is:
//          1. answer 200 "EVENT_RECEIVED" at once (Meta retries anything slower and floods on failure),
//          2. parse the body and find the connection by WABA id AND phone number id (identifiers, not secrets: they
//             only route),
//          3. read that connection's login from Vault with the service-role client and verify the signature over the
//             RAW body with THAT connection's app secret, in constant time,
//          4. only then store anything.
//        No app secret saved for the connection: the delivery is dropped (fixed log line, no ids). A bad or missing
//        signature: dropped and counted by the security event recorder (one event never alerts). Because the secret is
//        only known after the lookup, a delivery is never answered 403: a genuine, a forged and an unknown delivery all
//        get the same 200.
//
// Both are dormant (404) unless WHATSAPP_BYOK_ENABLED=true, like every other part of the feature.
//
// WHAT HAPPENS TO A MESSAGE. One row per message in whatsapp_messages (migration 0127), so a customer can read a whole
// thread. The sender's phone number is never stored or logged: the row holds a keyed hash of it (contact_key, per account)
// and a mask (contact_display), and Meta's message id is stored as a keyed hash as well (it embeds the number). With no
// WHATSAPP_CONTACT_HASH_KEY the message is dropped. A repeat delivery of the same message is a no-op, and only newly
// inserted rows are ever sent for AI triage (which is off unless WHATSAPP_INBOUND_TRIAGE_ENABLED=true). The 30 day purge
// (purge_stored_messages) deletes these rows by received_at. This path writes nothing to dm_conversations_cache or
// comment_triage.
// Fail closed everywhere: a WABA id plus phone number id that matches no connected, active WhatsApp row, an
// account whose own keys are out of credit, a paused row or a plan below Business stores nothing and costs nothing.
//
// Message text, names, phone numbers and secrets are never logged.

const VERIFY_TOKEN_ENV = "WHATSAPP_WEBHOOK_VERIFY_TOKEN";
const MAX_CHALLENGE_LENGTH = 256;
/** A delivery can batch many messages; this bounds the work (and the AI batches) one delivery can cause. */
const MAX_MESSAGES_PER_DELIVERY = 200;
/** WhatsApp text is at most 4096 characters; the whole message is kept (so a thread reads properly). */
const MAX_STORED_TEXT_CHARS = 4096;
/** Only this much of a message is ever sent to the AI (same ceiling the reply drafting prompt uses for a comment), which
 *  bounds the cost of one message. */
const MAX_TRIAGE_TEXT_CHARS = 1000;
/** Meta message ids look like wamid.HBgL...=; this is a loose shape check, not a format promise. */
const WAMID_PATTERN = /^[A-Za-z0-9._=+\/-]{5,300}$/;
const MAX_NAME_CHARS = 80;
const WA_ID_PATTERN = /^[0-9]{5,20}$/;

/** AI triage of inbound WhatsApp text is OFF unless this is exactly the string 'true'. Until the Privacy Policy names it,
 *  messages are captured and cached but no message text is ever sent to the AI provider. */
export const TRIAGE_FLAG_ENV = "WHATSAPP_INBOUND_TRIAGE_ENABLED";
const triageEnabled = (): boolean => process.env[TRIAGE_FLAG_ENV] === "true";

/** Most messages one account can send to the AI per UTC day. It bounds the bill one connected number (or someone who
 *  floods it with validly signed messages) can cause; beyond it messages are still stored, unclassified. In memory like
 *  the other abuse limiters in this backend: a deploy resetting the count early is a small, accepted gap. */
export const WHATSAPP_TRIAGE_DAILY_CAP = 200;
const triageToday = new Map<string, { day: string; count: number }>();
export function resetWhatsAppTriageCap(): void {
  triageToday.clear();
}
/** Reserves up to `wanted` triage slots for the account today and returns how many it got (0 when the cap is reached). */
function reserveTriageSlots(accountId: string, wanted: number): number {
  const day = new Date().toISOString().slice(0, 10);
  const entry = triageToday.get(accountId);
  const used = entry && entry.day === day ? entry.count : 0;
  const granted = Math.max(0, Math.min(wanted, WHATSAPP_TRIAGE_DAILY_CAP - used));
  triageToday.set(accountId, { day, count: used + granted });
  return granted;
}

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
  // The verify token is a HANDSHAKE token, not a credential: it is a string we choose and each customer types into the
  // webhook settings of their OWN Meta app, so Meta can check that the endpoint it was pointed at is ours. It protects
  // nothing (it proves no identity and unlocks no data); the per-customer app secret signature is what protects
  // deliveries. Unset means the handshake cannot succeed for anyone: fail closed with 403, the same answer as a wrong token.
  const expectedToken = process.env[VERIFY_TOKEN_ENV];
  if (!expectedToken) {
    console.error(`${VERIFY_TOKEN_ENV} is not set -- refusing the WhatsApp webhook verification handshake.`);
    res.status(403).end();
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
  // express.raw() in app.ts: the HMAC is over the exact bytes Meta sent. Anything else (wrong content type) is empty and
  // cannot match any signature.
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
  const signatureHeader = req.header("X-Hub-Signature-256") ?? "";

  // Answer first: the verifying secret is the connection's own and is only known after the lookup below.
  res.status(200).type("text/plain").send("EVENT_RECEIVED");

  const work = processWhatsAppEvent(rawBody, signatureHeader)
    .then((s) => console.log(`[whatsapp-webhook] processed: messages=${s.messages} stored=${s.stored} unmatched=${s.unmatched} blocked=${s.blocked} rejected=${s.rejected}`))
    // The error message only: it never carries the payload.
    .catch((err) => console.error("[whatsapp-webhook] processing failed:", err instanceof Error ? err.message : "unknown error"))
    .finally(() => inflight.delete(work));
  inflight.add(work);
}

/** HMAC-SHA256 over the raw body, compared in constant time against the X-Hub-Signature-256 header. */
export function signatureMatches(rawBody: Buffer, header: string, appSecret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(header, expected);
}

// ---------------------------------------------------------------- parsing

export interface WhatsAppTextMessage {
  /** The WhatsApp Business Account id (entry.id). */
  wabaId: string;
  /** metadata.phone_number_id: which of the business's numbers received it. */
  phoneNumberId: string;
  /** Meta's message id. Used only to de-duplicate, and only after it is turned into a keyed hash (it embeds the sender's
   *  number). */
  wamid: string;
  /** The sender's WhatsApp id (their phone number, digits only). Used in memory to derive the contact key and the mask;
   *  never stored and never logged. */
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
 *  (delivery receipts, reactions, media, templates, unknown types, a message with no usable id) is skipped. Never throws. */
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
        const wamid = isRecord(m) ? asString(m.id) : null;
        const body = isRecord(m) && m.type === "text" && isRecord(m.text) ? asString(m.text.body) : null;
        if (!isRecord(m) || !from || !WA_ID_PATTERN.test(from) || !wamid || !WAMID_PATTERN.test(wamid) || body === null || body.trim() === "") {
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
          wamid,
          from,
          name: rawName ? rawName.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_NAME_CHARS) || null : null,
          text: body.trim().slice(0, MAX_STORED_TEXT_CHARS),
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
  /** Messages newly stored (a message Meta delivered twice counts once). */
  stored: number;
  /** Messages for a WABA id + phone number id that matches no connected, active WhatsApp row. */
  unmatched: number;
  /** Messages for a matched row that was refused: out of credit, paused, a plan below Business, no saved app secret, or no
   *  contact hash key configured. */
  blocked: number;
  /** Messages for a matched row whose signature did not verify against that connection's own app secret. */
  rejected: number;
}

interface WhatsAppAccountRow {
  id: string;
  account_id: string;
  byok_status: string | null;
  paused_at: string | null;
  access_token_vault_id: string | null;
  needs_reconnect_at: string | null;
  disconnected_at: string | null;
  tokens_wiped_at: string | null;
}

/** A connection may receive messages only while it is a working, owned, current login. Everything else is dropped, and
 *  anything unexpected (an unknown status) fails closed: only an explicitly valid status passes. */
export function isReceivingConnection(a: WhatsAppAccountRow): boolean {
  return a.byok_status === "valid" && !a.needs_reconnect_at && !a.paused_at && !a.disconnected_at && !a.tokens_wiped_at;
}

export const NO_APP_SECRET_LOG_LINE = "whatsapp inbound disabled until an app secret is saved";
export const NO_CONTACT_KEY_LOG_LINE = "whatsapp inbound disabled until WHATSAPP_CONTACT_HASH_KEY is set";

/** Reads the connection's login from Vault (service role only) and returns its app secret, or why there is none.
 *  Nothing from the login is ever logged or thrown. */
async function loadAppSecret(vaultId: string | null): Promise<{ secret: string } | { missing: true } | { unreadable: true }> {
  if (!vaultId) return { missing: true };
  const { data, error } = await supabase.rpc("read_social_token", { p_vault_id: vaultId });
  if (error) return { unreadable: true };
  const bundle = parseWhatsAppBundle(typeof data === "string" ? data : null);
  return bundle?.appSecret ? { secret: bundle.appSecret } : { missing: true };
}

export async function processWhatsAppEvent(rawBody: Buffer, signatureHeader: string): Promise<WhatsAppEventSummary> {
  const summary: WhatsAppEventSummary = { messages: 0, stored: 0, unmatched: 0, blocked: 0, rejected: 0 };

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    // Not necessarily an attack: the signature is not checked yet. Nothing from the body is logged.
    console.error("[whatsapp-webhook] delivery was not valid JSON; dropped.");
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
    // the signature below is the real gate and this lookup only routes.
    const { data: rows, error } = await supabase
      .from("social_accounts")
      .select("id, account_id, byok_status, paused_at, access_token_vault_id, needs_reconnect_at, disconnected_at, tokens_wiped_at")
      .eq("platform", "whatsapp")
      .eq("whatsapp_business_account_id", wabaId)
      .eq("whatsapp_phone_number_id", phoneNumberId)
      .is("disconnected_at", null)
      .is("tokens_wiped_at", null);
    if (error) throw new Error("account lookup failed");
    const accounts = (rows ?? []) as WhatsAppAccountRow[];
    if (accounts.length === 0) {
      summary.unmatched += group.length;
      continue;
    }

    for (const account of accounts) {
      // Invalid or out-of-credit keys, a login that needs reconnecting, a paused, disconnected or wiped connection: nothing.
      if (!isReceivingConnection(account)) {
        summary.blocked += group.length;
        continue;
      }
      // The signature, with THIS connection's own app secret. Several accounts can share one number id: each is verified
      // with its own secret, and only the one whose secret signed the body gets the message.
      const loaded = await loadAppSecret(account.access_token_vault_id);
      if ("unreadable" in loaded) {
        console.error("[whatsapp-webhook] could not read a stored login; delivery dropped.");
        summary.blocked += group.length;
        continue;
      }
      if ("missing" in loaded) {
        console.warn(NO_APP_SECRET_LOG_LINE);
        summary.blocked += group.length;
        continue;
      }
      if (!signatureMatches(rawBody, signatureHeader, loaded.secret)) {
        // One bad signature is noise (a stale or misconfigured app); a flood trips the recorder's threshold. No ids.
        recordSecurityEvent("whatsapp_bad_signature", "WhatsApp webhook delivery failed signature verification");
        summary.rejected += group.length;
        continue;
      }
      if (!planOk.has(account.account_id)) planOk.set(account.account_id, (await checkWhatsappPlan(account.account_id)) === null);
      if (!planOk.get(account.account_id)) {
        summary.blocked += group.length;
        continue;
      }
      // Fail closed on privacy: without the server's hash key no phone number can be turned into a safe key, and the raw
      // number must never be stored, so the message is dropped (it is not kept anywhere).
      if (!contactHashKey()) {
        console.warn(NO_CONTACT_KEY_LOG_LINE);
        summary.blocked += group.length;
        continue;
      }
      summary.stored += await storeAndTriage(account, group);
    }
  }
  return summary;
}

/** One database row per message. The unique key (social_account_id, wamid) makes a repeat delivery a no-op, and only a
 *  row that was newly inserted is ever sent for triage, so a retry costs nothing. Two different messages in the same
 *  second are two rows (there is no per-conversation overwrite any more). Returns how many rows were newly inserted. */
async function storeAndTriage(account: WhatsAppAccountRow, group: WhatsAppTextMessage[]): Promise<number> {
  const rows: Array<Record<string, unknown>> = [];
  for (const m of group) {
    const contactKey = contactKeyFor(account.account_id, m.from);
    const messageKey = messageKeyFor(account.account_id, m.wamid);
    if (!contactKey || !messageKey) continue; // cannot happen after the key check above; never store without both
    rows.push({
      account_id: account.account_id,
      social_account_id: account.id,
      wamid: messageKey,
      contact_key: contactKey,
      contact_display: maskPhone(m.from),
      contact_name: m.name,
      text: m.text,
      received_at: m.at.toISOString(),
    });
  }
  if (rows.length === 0) return 0;

  // Insert, ignoring rows whose (social_account_id, wamid) already exists; the result holds only the rows that are new.
  const { data: inserted, error } = await supabase
    .from("whatsapp_messages")
    .upsert(rows, { onConflict: "social_account_id,wamid", ignoreDuplicates: true })
    .select("id, text, contact_name");
  if (error) throw new Error("message write failed");
  const fresh = (inserted ?? []) as Array<{ id: string; text: string; contact_name: string | null }>;
  if (fresh.length === 0) return 0;

  // Triage is off by default (see TRIAGE_FLAG_ENV): the messages above are already stored, unclassified, and nothing
  // leaves for the AI provider. When on, only up to the account's daily allowance goes; the rest stays unclassified.
  const allowed = triageEnabled() ? reserveTriageSlots(account.account_id, fresh.length) : 0;
  if (allowed > 0) {
    const items: TriageItem[] = fresh.slice(0, allowed).map((r) => ({
      itemId: r.id,
      sourceSignature: "",
      author: sanitizeUntrustedMessage(r.contact_name ?? "", 80) || "WhatsApp contact",
      text: sanitizeUntrustedMessage(r.text, MAX_TRIAGE_TEXT_CHARS),
    }));
    try {
      // Failure, no API key or an unusable answer leaves the message unclassified (null), never "routine", and never
      // loses the message that is already stored.
      // One model call classifies at most MAX_ITEMS_PER_BATCH items, so a larger set goes in chunks.
      const verdicts = new Map<string, TriageResult>();
      for (let i = 0; i < items.length; i += MAX_ITEMS_PER_BATCH) {
        for (const [id, v] of await classifyUntrustedMessages(items.slice(i, i + MAX_ITEMS_PER_BATCH))) verdicts.set(id, v);
      }
      const triagedAt = new Date().toISOString();
      for (const [id, v] of verdicts) {
        const { error: updateError } = await supabase
          .from("whatsapp_messages")
          .update({ triage_category: v.category, needs_attention: v.needsAttention, triage_reason: v.reason, triaged_at: triagedAt })
          .eq("id", id);
        if (updateError) console.error("[whatsapp-webhook] could not save a triage verdict.");
      }
    } catch (err) {
      console.error("[whatsapp-webhook] triage failed:", err instanceof Error ? err.message : "unknown error");
    }
  }
  return fresh.length;
}

// ---------------------------------------------------------------- route limits

/** Meta documents webhook payloads of up to 3 MB (developers.facebook.com, WhatsApp Cloud API, "Set up webhooks":
 *  "Webhook payloads can be up to 3 MB"). Checked 2026-10-10. */
export const WHATSAPP_WEBHOOK_MAX_BYTES = 3 * 1024 * 1024;
/** Meta can burst (it retries a failing endpoint for days and batches deliveries), so this is far more generous than the
 *  30 a minute publicRateLimit gives the other public endpoints. Per source IP, and one ceiling for all callers together. */
export const WHATSAPP_WEBHOOK_PER_IP_PER_MINUTE = 600;
export const WHATSAPP_WEBHOOK_GLOBAL_PER_MINUTE = 6000;

/** Cheapest check first: a declared size over the ceiling is refused before any body is read or parsed. (express.raw
 *  enforces the same limit on the bytes actually sent, which covers a lying or missing Content-Length.) */
export function rejectOversizeWebhook(req: Request, res: Response, next: NextFunction): void {
  const declared = Number(req.header("content-length"));
  if (Number.isFinite(declared) && declared > WHATSAPP_WEBHOOK_MAX_BYTES) {
    res.status(413).end();
    return;
  }
  next();
}

/** The middleware chain for POST, in order: oversize guard, a global ceiling, a per-IP ceiling. Built per call so tests
 *  can use small numbers and each app instance has its own counters. */
export function buildWhatsAppWebhookLimits(opts: { perIp?: number; global?: number } = {}) {
  const tooMany = (_req: Request, res: Response) => {
    recordSecurityEvent("rate_limited", "WhatsApp webhook request rate ceiling reached");
    res.status(429).end();
  };
  const common = { windowMs: 60_000, standardHeaders: false, legacyHeaders: false, handler: tooMany, validate: false } as const;
  const globalCeiling = rateLimit({ ...common, max: opts.global ?? WHATSAPP_WEBHOOK_GLOBAL_PER_MINUTE, keyGenerator: () => "whatsapp-webhook-global" });
  const perIp = rateLimit({ ...common, max: opts.perIp ?? WHATSAPP_WEBHOOK_PER_IP_PER_MINUTE, keyGenerator: (req: Request) => req.ip ?? "unknown" });
  return [rejectOversizeWebhook, globalCeiling, perIp];
}
