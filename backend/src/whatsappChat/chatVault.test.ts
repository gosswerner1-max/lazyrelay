// Chat message bodies, approval titles and a conversation's number are stored only as AES-256-GCM envelopes (same keys and format
// as the contact numbers). Each is bound to its account and its own place, so a value copied onto another row does not decrypt.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptBody, decryptBody, encryptTitle, decryptTitle } from "./chatVault.js";
import { serviceWindow, SERVICE_WINDOW_MS } from "./window.js";

const SAVED = { ...process.env };
beforeEach(() => {
  process.env.WHATSAPP_CONTACT_HASH_KEY = "h".repeat(40);
  process.env.WHATSAPP_CONTACT_ENC_KEY = randomBytes(32).toString("base64");
  process.env.WHATSAPP_CONTACT_ENC_KEY_ID = "k1";
});
afterEach(() => {
  process.env = { ...SAVED };
});

const FORMAT = /^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

describe("chat vault", () => {
  it("round-trips a body, including emoji and line breaks, and the envelope matches the database format check", () => {
    const text = "Hi Thandi 👋\nYour proof is ready: https://example.com/p/1";
    const env = encryptBody("acc1", "conv1", text);
    expect(env).toMatch(FORMAT);
    expect(env).not.toContain("Thandi");
    expect(decryptBody("acc1", "conv1", env)).toBe(text);
  });

  it("a different message encrypts differently every time (fresh IV)", () => {
    expect(encryptBody("acc1", "conv1", "same")).not.toBe(encryptBody("acc1", "conv1", "same"));
  });

  it("a body copied to another conversation or another account does not decrypt", () => {
    const env = encryptBody("acc1", "conv1", "secret");
    expect(() => decryptBody("acc1", "conv2", env)).toThrow();
    expect(() => decryptBody("acc2", "conv1", env)).toThrow();
  });

  it("a title is bound separately from a body", () => {
    const env = encryptTitle("acc1", "conv1", "Logo proof v2");
    expect(decryptTitle("acc1", "conv1", env)).toBe("Logo proof v2");
    expect(() => decryptBody("acc1", "conv1", env)).toThrow();
  });

  it("refuses with no key (fail closed, never plain text)", () => {
    delete process.env.WHATSAPP_CONTACT_ENC_KEY;
    expect(() => encryptBody("acc1", "conv1", "x")).toThrow();
  });
});

describe("serviceWindow (Meta's 24 hour customer-service window)", () => {
  const NOW = new Date("2026-10-16T12:00:00.000Z");
  const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

  it("is 24 hours", () => {
    expect(SERVICE_WINDOW_MS).toBe(24 * 3_600_000);
  });

  it("is closed when the person never wrote", () => {
    expect(serviceWindow(null, NOW)).toEqual({ open: false, expiresAt: null, hoursLeft: 0 });
  });

  it("is open for 24 hours after the person's last message, and says when it closes and how many hours are left (rounded up)", () => {
    expect(serviceWindow(at(60_000), NOW)).toEqual({ open: true, expiresAt: new Date(NOW.getTime() - 60_000 + SERVICE_WINDOW_MS).toISOString(), hoursLeft: 24 });
    expect(serviceWindow(at(23 * 3_600_000 + 30 * 60_000), NOW)).toMatchObject({ open: true, hoursLeft: 1 });
  });

  it("closes at exactly 24 hours", () => {
    expect(serviceWindow(at(SERVICE_WINDOW_MS), NOW).open).toBe(false);
    expect(serviceWindow(at(SERVICE_WINDOW_MS - 1), NOW).open).toBe(true);
  });

  it("an unreadable time is closed (fail closed), and a time in the future is not trusted", () => {
    expect(serviceWindow("nope", NOW).open).toBe(false);
    expect(serviceWindow(new Date(NOW.getTime() + 3_600_000).toISOString(), NOW).open).toBe(false);
  });
});
