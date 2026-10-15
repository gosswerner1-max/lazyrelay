// AES-256-GCM envelope for the customer-uploaded contact phone numbers. Throwaway in-memory keys only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptPhone, decryptPhone, phoneVaultConfigured, PhoneVaultError } from "./phoneVault.js";

const newKey = () => randomBytes(32).toString("base64");
const ACC = "11111111-1111-4111-8111-111111111111";
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const SAVED = { ...process.env };

beforeEach(() => {
  process.env.WHATSAPP_CONTACT_ENC_KEY = newKey();
  process.env.WHATSAPP_CONTACT_ENC_KEY_ID = "k1";
  delete process.env.WHATSAPP_CONTACT_ENC_KEY_PREV;
  delete process.env.WHATSAPP_CONTACT_HASH_KEY;
});
afterEach(() => {
  process.env = { ...SAVED };
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof PhoneVaultError ? e.code : "other";
  }
  return "no_error";
};

describe("phoneVault", () => {
  it("round trips and uses the documented envelope", () => {
    const env = encryptPhone(ACC, KEY_A, "+27821234567");
    expect(env).toMatch(/^v1\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(env).not.toContain("27821234567");
    expect(decryptPhone(ACC, KEY_A, env)).toBe("+27821234567");
  });

  it("uses a fresh IV every time", () => {
    expect(encryptPhone(ACC, KEY_A, "+27821234567")).not.toBe(encryptPhone(ACC, KEY_A, "+27821234567"));
  });

  it("fails with a different account or contact key (AAD binds the row)", () => {
    const env = encryptPhone(ACC, KEY_A, "+27821234567");
    expect(codeOf(() => decryptPhone(ACC, KEY_B, env))).toBe("decrypt_failed");
    expect(codeOf(() => decryptPhone("22222222-2222-4222-8222-222222222222", KEY_A, env))).toBe("decrypt_failed");
  });

  it("fails when the ciphertext, tag or iv is tampered", () => {
    const [v, id, iv, tag, ct] = encryptPhone(ACC, KEY_A, "+27821234567").split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [[v, id, iv, tag, flip(ct)], [v, id, iv, flip(tag), ct], [v, id, flip(iv), tag, ct]]) {
      expect(codeOf(() => decryptPhone(ACC, KEY_A, bad.join(".")))).toBe("decrypt_failed");
    }
  });

  it("rejects malformed envelopes", () => {
    expect(codeOf(() => decryptPhone(ACC, KEY_A, "garbage"))).toBe("bad_envelope");
    expect(codeOf(() => decryptPhone(ACC, KEY_A, "v2.k1.a.b.c"))).toBe("bad_envelope");
  });

  it("fails closed when no key, a short key, no key id, or the hash key is reused", () => {
    delete process.env.WHATSAPP_CONTACT_ENC_KEY;
    expect(phoneVaultConfigured()).toBe(false);
    expect(codeOf(() => encryptPhone(ACC, KEY_A, "+27821234567"))).toBe("key_missing");
    process.env.WHATSAPP_CONTACT_ENC_KEY = randomBytes(16).toString("base64");
    expect(codeOf(() => encryptPhone(ACC, KEY_A, "+27821234567"))).toBe("key_missing");
    process.env.WHATSAPP_CONTACT_ENC_KEY = newKey();
    delete process.env.WHATSAPP_CONTACT_ENC_KEY_ID;
    expect(codeOf(() => encryptPhone(ACC, KEY_A, "+27821234567"))).toBe("key_missing");
    process.env.WHATSAPP_CONTACT_ENC_KEY_ID = "k1";
    process.env.WHATSAPP_CONTACT_HASH_KEY = process.env.WHATSAPP_CONTACT_ENC_KEY;
    expect(phoneVaultConfigured()).toBe(false);
    expect(codeOf(() => encryptPhone(ACC, KEY_A, "+27821234567"))).toBe("key_missing");
  });

  it("reads a value written under the previous key after rotation, and writes with the new one", () => {
    const oldKey = process.env.WHATSAPP_CONTACT_ENC_KEY!;
    const oldEnv = encryptPhone(ACC, KEY_A, "+27821234567");
    process.env.WHATSAPP_CONTACT_ENC_KEY = newKey();
    process.env.WHATSAPP_CONTACT_ENC_KEY_ID = "k2";
    process.env.WHATSAPP_CONTACT_ENC_KEY_PREV = oldKey;
    expect(decryptPhone(ACC, KEY_A, oldEnv)).toBe("+27821234567");
    expect(encryptPhone(ACC, KEY_A, "+27821234567").split(".")[1]).toBe("k2");
    delete process.env.WHATSAPP_CONTACT_ENC_KEY_PREV;
    expect(codeOf(() => decryptPhone(ACC, KEY_A, oldEnv))).toBe("decrypt_failed");
  });

  it("never puts a key or the number in an error message", () => {
    process.env.WHATSAPP_CONTACT_ENC_KEY = "not-a-key";
    let message = "";
    try {
      encryptPhone(ACC, KEY_A, "+27821234567");
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).not.toBe("");
    expect(message).not.toMatch(/not-a-key|27821234567/);
  });
});
