import type { Request, Response } from "express";
import { syncSubscriptionFromWebhook, recordBillingEvent } from "../billing/sync.js";
import { WebhookSignatureError } from "../billing/types.js";
import type { MerchantOfRecordAdapter } from "../billing/types.js";

// A prior IP-allowlist check against api.paddle.com/ips was removed
// 2026-08-11 — real production traffic proved it was rejecting 100% of
// genuine Paddle webhooks. Paddle's webhook deliveries route through
// Cloudflare, so the source IP this server ever actually sees (observed:
// 104.22.x.x / 172.7x.x.x, real Cloudflare edge ranges) never matches
// Paddle's published origin IPs (AWS ranges) — every live delivery was
// silently 403'd since this was built, confirmed via Render's own logs and
// Paddle's notification log (every event stuck at queued_for_retry).
// Signature verification below is the real, correct security gate — Paddle
// forged signatures fail HMAC verification regardless of source IP, so this
// wasn't defense-in-depth, it was a false sense of one.
export function buildWebhookHandler(morAdapter: MerchantOfRecordAdapter) {
  return async (req: Request, res: Response) => {
    const signature = req.headers["x-signature"] ?? req.headers["paddle-signature"] ?? "";
    const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body);

    let event;
    try {
      event = await morAdapter.parseWebhookEvent(rawBody, String(signature));
    } catch (err) {
      // Never trust an unverified webhook — reject outright rather than
      // processing it "just in case." A forged webhook could otherwise
      // grant free access or falsely mark a real subscription cancelled.
      // Only a genuine signature mismatch gets the 401 "Invalid webhook
      // signature" response — anything else thrown here (unmapped status,
      // missing customData, a malformed payload) is a real, correctly-signed
      // Paddle delivery with a data problem, not a security event, so it
      // gets its own honest error instead of masquerading as the former
      // (found the hard way 2026-08-11 — both used to look identical).
      if (err instanceof WebhookSignatureError) {
        console.error("Webhook signature verification failed:", err);
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }
      console.error("Webhook payload could not be processed:", err);
      res.status(400).json({ error: err instanceof Error ? err.message : "Unable to process webhook payload" });
      return;
    }

    // A verified-but-irrelevant event (e.g. Stripe's charge.refunded,
    // payment_intent.succeeded) — genuinely nothing to sync, not an error.
    if (event === null) {
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    try {
      if (event.kind === "sale_record" || event.kind === "refund_record") {
        await recordBillingEvent(event, morAdapter);
      } else {
        await syncSubscriptionFromWebhook(event);
      }
      res.status(200).json({ received: true });
    } catch (err) {
      console.error("Webhook processing failed:", err);
      res.status(500).json({ error: "Processing failed" });
    }
  };
}
