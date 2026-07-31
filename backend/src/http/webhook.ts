import type { Request, Response } from "express";
import { syncSubscriptionFromWebhook, recordBillingEvent } from "../billing/sync.js";
import type { MerchantOfRecordAdapter } from "../billing/types.js";

// Paddle's live source IPs for webhook delivery — fetched from Paddle's own
// endpoint (the source of truth, and one Paddle says can change) rather than
// hardcoded. This is defense-in-depth ON TOP OF signature verification below,
// not a replacement for it: if the fetch fails or is stale, we fail OPEN
// (allow through) and rely on signature verification alone, since a Paddle-
// side outage of this endpoint must never block real subscription webhooks.
let cachedCidrs: string[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

async function getPaddleIpCidrs(): Promise<string[] | null> {
  const now = Date.now();
  if (cachedCidrs && now - cachedAt < CACHE_TTL_MS) return cachedCidrs;
  try {
    const res = await fetch("https://api.paddle.com/ips");
    const json = (await res.json()) as { data: { ipv4_cidrs: string[] } };
    cachedCidrs = json.data.ipv4_cidrs;
    cachedAt = now;
    return cachedCidrs;
  } catch (err) {
    console.error("Failed to refresh Paddle webhook IP allowlist — allowing through, signature verification remains the real gate:", err);
    return cachedCidrs;
  }
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/** Receives raw MoR webhook payloads. Must be mounted with a raw-body
 *  parser (not express.json()), since signature verification needs the
 *  exact bytes the provider signed, not a re-serialized JSON object. */
export function buildWebhookHandler(morAdapter: MerchantOfRecordAdapter) {
  return async (req: Request, res: Response) => {
    const cidrs = await getPaddleIpCidrs();
    const clientIp = (req.ip ?? "").replace(/^::ffff:/, "");
    if (cidrs && clientIp && !cidrs.some((cidr) => ipInCidr(clientIp, cidr))) {
      console.warn(`Webhook request from non-Paddle IP ${clientIp} rejected`);
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const signature = req.headers["x-signature"] ?? req.headers["paddle-signature"] ?? "";
    const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body);

    let event;
    try {
      event = await morAdapter.parseWebhookEvent(rawBody, String(signature));
    } catch (err) {
      // Never trust an unverified webhook — reject outright rather than
      // processing it "just in case." A forged webhook could otherwise
      // grant free access or falsely mark a real subscription cancelled.
      console.error("Webhook signature verification failed:", err);
      res.status(401).json({ error: "Invalid webhook signature" });
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
        await recordBillingEvent(event);
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
