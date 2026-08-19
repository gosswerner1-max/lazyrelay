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
    // `url` already passed isSafeMediaUrl at the time it was saved (PATCH
    // /account, routes.ts), but that only checked the URL itself, not
    // wherever it might redirect to — the default "follow" would happily
    // chase a 3xx into a private/internal address the initial check never
    // saw. Refusing to follow closes that gap without needing to re-resolve
    // and re-validate every hop.
    redirect: "manual",
  })
    .then((res) => {
      if (res.status >= 300 && res.status < 400) {
        console.error(`[webhook] delivery to ${url} was refused because it returned a redirect (${res.status}) — redirects are not followed`);
        return;
      }
      if (!res.ok) console.error(`[webhook] delivery to ${url} returned ${res.status}`);
    })
    .catch((err) => console.error("[webhook] delivery failed:", err instanceof Error ? err.message : err));
}
