import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature, WEBHOOK_EVENTS, WEBHOOK_SIGNATURE_HEADER } from "../src/index.js";

// The backend's exact algorithm (backend/src/webhook.ts, signWebhookBody), copied here on purpose:
// HMAC-SHA256 of the JSON string, hex digest. The secret is generateWebhookSecret(): 32 random bytes as hex.
const signLikeTheBackend = (secret: string, json: string): string => createHmac("sha256", secret).update(json).digest("hex");

const secret = randomBytes(32).toString("hex");
const payload = { event: "post.verified", eventId: "8b1c8f0e-0000-4000-8000-000000000001", createdAt: "2026-09-30T10:00:00.000Z", postId: "p1", platform: "instagram", url: "https://instagram.com/p/x" };
const rawBody = JSON.stringify(payload);
const signature = signLikeTheBackend(secret, rawBody);

describe("verifyWebhookSignature", () => {
  it("accepts a signature made the way the backend makes it", () => {
    expect(verifyWebhookSignature({ secret, rawBody, signature })).toBe(true);
  });

  it("accepts the raw bytes as well as a string", () => {
    expect(verifyWebhookSignature({ secret, rawBody: Buffer.from(rawBody, "utf8"), signature })).toBe(true);
    expect(verifyWebhookSignature({ secret, rawBody: new TextEncoder().encode(rawBody), signature })).toBe(true);
  });

  it("verifies a body with non ASCII text", () => {
    const body = JSON.stringify({ ...payload, text: "Café ✨ 你好" });
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: signLikeTheBackend(secret, body) })).toBe(true);
    expect(verifyWebhookSignature({ secret, rawBody: Buffer.from(body, "utf8"), signature: signLikeTheBackend(secret, body) })).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyWebhookSignature({ secret, rawBody: rawBody.replace("post.verified", "post.failed"), signature })).toBe(false);
    expect(verifyWebhookSignature({ secret, rawBody: `${rawBody} `, signature })).toBe(false);
    expect(verifyWebhookSignature({ secret, rawBody: "", signature })).toBe(false);
  });

  it("rejects re-serialised JSON that changes whitespace", () => {
    expect(verifyWebhookSignature({ secret, rawBody: JSON.stringify(payload, null, 2), signature })).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyWebhookSignature({ secret: randomBytes(32).toString("hex"), rawBody, signature })).toBe(false);
    expect(verifyWebhookSignature({ secret: `${secret}x`, rawBody, signature })).toBe(false);
  });

  it("rejects a missing, empty or malformed signature without throwing", () => {
    for (const bad of [undefined, null, "", "   ", "abc", "zz".repeat(32), signature.slice(0, -1), `${signature}0`, `sha256=${signature}`]) {
      expect(verifyWebhookSignature({ secret, rawBody, signature: bad as string })).toBe(false);
    }
  });

  it("rejects an empty secret", () => {
    expect(verifyWebhookSignature({ secret: "", rawBody, signature: signLikeTheBackend("", rawBody) })).toBe(false);
  });

  it("tolerates surrounding whitespace and upper case hex in the header value", () => {
    expect(verifyWebhookSignature({ secret, rawBody, signature: ` ${signature.toUpperCase()} ` })).toBe(true);
  });

  it("rejects a signature that differs in one character", () => {
    const flipped = (signature[0] === "a" ? "b" : "a") + signature.slice(1);
    expect(verifyWebhookSignature({ secret, rawBody, signature: flipped })).toBe(false);
  });

  it("exposes the header name and the event list the backend uses", () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("X-LazyRelay-Signature");
    expect(WEBHOOK_EVENTS).toEqual(["post.verified", "post.failed", "post.unconfirmed", "channel.needs_reconnect"]);
  });
});
