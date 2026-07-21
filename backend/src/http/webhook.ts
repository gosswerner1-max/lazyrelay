import type { Request, Response } from "express";
import { syncSubscriptionFromWebhook } from "../billing/sync.js";
import type { MerchantOfRecordAdapter } from "../billing/types.js";

/** Receives raw MoR webhook payloads. Must be mounted with a raw-body
 *  parser (not express.json()), since signature verification needs the
 *  exact bytes the provider signed, not a re-serialized JSON object. */
export function buildWebhookHandler(morAdapter: MerchantOfRecordAdapter) {
  return async (req: Request, res: Response) => {
    const signature = req.headers["x-signature"] ?? req.headers["paddle-signature"] ?? "";
    const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body);

    let event;
    try {
      event = morAdapter.parseWebhookEvent(rawBody, String(signature));
    } catch (err) {
      // Never trust an unverified webhook — reject outright rather than
      // processing it "just in case." A forged webhook could otherwise
      // grant free access or falsely mark a real subscription cancelled.
      console.error("Webhook signature verification failed:", err);
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    try {
      await syncSubscriptionFromWebhook(event);
      res.status(200).json({ received: true });
    } catch (err) {
      console.error("Webhook processing failed:", err);
      res.status(500).json({ error: "Processing failed" });
    }
  };
}
