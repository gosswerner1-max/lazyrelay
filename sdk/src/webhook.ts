import { createHmac, timingSafeEqual } from "node:crypto";

/** The header LazyRelay puts the signature in. */
export const WEBHOOK_SIGNATURE_HEADER = "X-LazyRelay-Signature";
/** The event name, for example post.verified. */
export const WEBHOOK_EVENT_HEADER = "X-LazyRelay-Event";
/** Stable across retries of one event: use it to ignore a repeat. */
export const WEBHOOK_DELIVERY_HEADER = "X-LazyRelay-Delivery";
/** 1 on the first try, up to 6. */
export const WEBHOOK_ATTEMPT_HEADER = "X-LazyRelay-Attempt";

/** The events an endpoint can subscribe to. webhook.test is sent only by the dashboard Send test button. */
export const WEBHOOK_EVENTS = ["post.verified", "post.failed", "post.unconfirmed", "channel.needs_reconnect"] as const;

export interface VerifyWebhookSignatureInput {
  /** The endpoint secret, shown once in the dashboard under Settings, Webhooks. */
  secret: string;
  /** The body exactly as received, before any JSON parsing. A string or the raw bytes. */
  rawBody: string | Uint8Array;
  /** The value of the X-LazyRelay-Signature header. */
  signature: string | null | undefined;
}

/**
 * Checks a webhook signature. LazyRelay signs the raw JSON body with HMAC-SHA256 using the
 * endpoint secret and sends the lowercase hex digest, with no prefix, in X-LazyRelay-Signature
 * (backend/src/webhook.ts, signWebhookBody). The comparison is constant time. Returns false for a
 * missing, malformed or wrong signature; it does not throw for bad input.
 *
 * Verify against the raw body. Re-serialising parsed JSON can change whitespace or key order and
 * break the match.
 */
export function verifyWebhookSignature({ secret, rawBody, signature }: VerifyWebhookSignatureInput): boolean {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof signature !== "string") return false;
  const received = signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(received, "hex"));
}
