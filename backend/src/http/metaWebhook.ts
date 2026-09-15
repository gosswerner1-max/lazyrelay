import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

// Same field list used for the one-time manual fix applied live 2026-09-15
// to LazyRelay's own three Pages -- kept here so every future connection
// gets it automatically instead of needing another manual pass.
const MESSAGING_SUBSCRIBED_FIELDS =
  "messages,messaging_postbacks,message_reactions,messaging_referrals,message_echoes,message_edits,feed";

/** Subscribes a Facebook Page to the webhook fields Instagram/Facebook
 *  Messaging needs to work at all (see the file-level comment above).
 *  Called right after a Facebook/Instagram connect completes — see
 *  connect.ts's storeConnectedAccount. Failure is logged, not thrown: a
 *  customer's connect should still succeed even if this side-call to Meta
 *  has a transient problem, same as any other best-effort follow-up call
 *  in this codebase. */
export async function subscribePageToMessaging(pageId: string, pageAccessToken: string): Promise<void> {
  try {
    const url = `https://graph.facebook.com/v25.0/${pageId}/subscribed_apps?subscribed_fields=${MESSAGING_SUBSCRIBED_FIELDS}&access_token=${encodeURIComponent(pageAccessToken)}`;
    const res = await fetch(url, { method: "POST" });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { message?: string } };
    if (!res.ok || !json.success) {
      console.error(`Meta messaging subscription failed for page ${pageId}:`, json.error?.message ?? `HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`Meta messaging subscription failed for page ${pageId}:`, err);
  }
}

// Meta (Facebook/Instagram) gates its whole Messenger/Instagram Messaging
// product behind having a live, registered webhook -- confirmed live
// 2026-09-15: GET /{app-id}/subscriptions came back completely empty, and
// every Instagram conversations call failed with "(#3) Application does not
// have the capability to make this API call" even for our own admin
// account with the right OAuth permissions already granted. Classic
// Facebook Page conversations didn't enforce this the same way, which is
// why only Instagram was failing. Real-time event *processing* is out of
// scope here -- mentionsAndDmsPoller.ts already polls on a schedule and
// keeps doing so. This endpoint's only job is to exist, verify itself to
// Meta, and verify incoming signatures, which is what actually unlocks the
// capability for the polling calls to work at all.

// Meta's one-time subscription handshake: it GETs this URL with these three
// query params and expects the raw hub.challenge value echoed back verbatim
// if hub.verify_token matches what we registered. Wrong/missing token ->
// reject, same fail-closed spirit as every other webhook in this codebase.
export function handleMetaWebhookVerification(req: Request, res: Response) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!expectedToken) {
    console.error("META_WEBHOOK_VERIFY_TOKEN is not set -- refusing Meta's webhook verification handshake.");
    res.status(500).end();
    return;
  }

  const tokenMatches =
    typeof token === "string" &&
    Buffer.byteLength(token) === Buffer.byteLength(expectedToken) &&
    timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));

  if (mode !== "subscribe" || !tokenMatches || typeof challenge !== "string") {
    res.status(403).end();
    return;
  }

  res.status(200).send(challenge);
}

// Real deliveries: Meta signs the raw JSON body with our app secret
// (X-Hub-Signature-256: sha256=<hex hmac>). Mounted before express.json()
// in app.ts, same reason as the MOR webhook -- the parser would otherwise
// consume the body this needs to verify against.
export function handleMetaWebhookEvent(req: Request, res: Response) {
  const appSecret = process.env.META_APP_SECRET;
  const signatureHeader = req.header("X-Hub-Signature-256") ?? "";
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from("");

  if (!appSecret) {
    console.error("META_APP_SECRET is not set -- refusing an unverifiable Meta webhook delivery.");
    res.status(500).end();
    return;
  }

  const expectedSignature = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const signatureMatches =
    Buffer.byteLength(signatureHeader) === Buffer.byteLength(expectedSignature) &&
    timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSignature));

  if (!signatureMatches) {
    console.error("Meta webhook signature verification failed.");
    res.status(403).end();
    return;
  }

  // Nothing consumes these events yet (see the file-level comment) -- just
  // acknowledge quickly, which Meta requires within 5 seconds, and log a
  // summary so a future real-time build has evidence deliveries actually
  // arrive rather than starting from zero.
  try {
    const parsed = JSON.parse(rawBody.toString("utf8"));
    const entryCount = Array.isArray(parsed?.entry) ? parsed.entry.length : 0;
    console.log(`Meta webhook received: object=${parsed?.object ?? "unknown"} entries=${entryCount}`);
  } catch (err) {
    console.error("Meta webhook payload was not valid JSON despite a valid signature:", err);
  }

  res.status(200).end();
}
