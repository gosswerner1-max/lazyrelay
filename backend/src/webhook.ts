import { createHmac, randomBytes } from "node:crypto";

// Proof-of-Publish webhook (2026-08-08) — item 5 from the 2026-08-07
// competitor audit. See migration 0041_webhooks.sql for why the secret is
// stored in plaintext (needed to sign each delivery, not just verify one).

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

interface VerifiedPostPayload {
  event: "post.verified";
  postId: string;
  platform: string;
  content: string;
  platformPostUrl: string | null;
  verifiedAt: string;
}

/** Fire-and-forget by design, same as sendFailureAlert/notifyOps — a failed
 *  delivery must never affect the scheduler's own post-processing path.
 *  Single attempt, no retry queue (see the audit item's "small, cheap
 *  addition" framing) — a customer whose endpoint is temporarily down just
 *  misses that one delivery, the same tradeoff every fire-and-forget
 *  integration in this codebase already makes. 10s timeout so a hung
 *  endpoint can't leak an unbounded in-flight request. */
export function sendVerifiedWebhook(url: string, secret: string, payload: Omit<VerifiedPostPayload, "event">): void {
  const body: VerifiedPostPayload = { event: "post.verified", ...payload };
  const json = JSON.stringify(body);
  const signature = createHmac("sha256", secret).update(json).digest("hex");

  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-LazyRelay-Event": body.event,
      "X-LazyRelay-Signature": signature,
    },
    body: json,
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (!res.ok) console.error(`[webhook] delivery to ${url} returned ${res.status}`);
    })
    .catch((err) => console.error("[webhook] delivery failed:", err instanceof Error ? err.message : err));
}
