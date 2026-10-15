// Encrypts the phone number of a customer-uploaded broadcast contact so it can be stored at all (decision D1, 2026-10-15:
// only for contacts the customer uploaded for broadcasts, encrypted, never in clear). AES-256-GCM through node:crypto.
//
//   envelope     v1.<keyid>.<iv>.<tag>.<ciphertext>, the last three base64url, <keyid> a short label (not secret).
//   AAD          account_id|contact_key: a ciphertext copied onto another row (another account, another contact) does not
//                decrypt.
//   keys         WHATSAPP_CONTACT_ENC_KEY (base64, exactly 32 bytes) and WHATSAPP_CONTACT_ENC_KEY_ID. For rotation keep the
//                old key in WHATSAPP_CONTACT_ENC_KEY_PREV (base64) for as long as old rows exist: a value written under any
//                other id is tried against it (the GCM tag decides). Writes always use the current key.
//   fail closed  no usable key means refuse (PhoneVaultError "key_missing"), never plaintext, never a fallback key. It is a
//                separate secret from WHATSAPP_CONTACT_HASH_KEY and is refused if the two are equal.
//
// Errors carry a code and a fixed message: never the number, a key or a ciphertext.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CONTACT_ENC_KEY_ENV = "WHATSAPP_CONTACT_ENC_KEY";
export const CONTACT_ENC_KEY_ID_ENV = "WHATSAPP_CONTACT_ENC_KEY_ID";
export const CONTACT_ENC_KEY_PREV_ENV = "WHATSAPP_CONTACT_ENC_KEY_PREV";

const VERSION = "v1";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type PhoneVaultErrorCode = "key_missing" | "bad_envelope" | "decrypt_failed";

export class PhoneVaultError extends Error {
  constructor(readonly code: PhoneVaultErrorCode) {
    super(
      code === "key_missing"
        ? "The contact encryption key is not configured."
        : code === "bad_envelope"
          ? "The stored contact value is not in a readable format."
          : "The stored contact value could not be decrypted.",
    );
    this.name = "PhoneVaultError";
  }
}

function parseKey(value: string | undefined): Buffer | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const key = Buffer.from(value.trim(), "base64");
  return key.length === 32 ? key : null;
}

function currentKey(): { id: string; key: Buffer } | null {
  const raw = process.env[CONTACT_ENC_KEY_ENV];
  const key = parseKey(raw);
  const id = (process.env[CONTACT_ENC_KEY_ID_ENV] ?? "").trim();
  if (!key || !KEY_ID_PATTERN.test(id)) return null;
  // Never reuse the contact-hash secret as the encryption key.
  if (raw!.trim() === (process.env.WHATSAPP_CONTACT_HASH_KEY ?? "").trim()) return null;
  return { id, key };
}

/** True when the encryption key and its id are set and usable. */
export function phoneVaultConfigured(): boolean {
  return currentKey() !== null;
}

const aad = (accountId: string, contactKey: string) => Buffer.from(`${accountId}|${contactKey}`, "utf8");

export function encryptPhone(accountId: string, contactKey: string, e164: string): string {
  const current = currentKey();
  if (!current) throw new PhoneVaultError("key_missing");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", current.key, iv);
  cipher.setAAD(aad(accountId, contactKey));
  const ct = Buffer.concat([cipher.update(e164, "utf8"), cipher.final()]);
  return [VERSION, current.id, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptPhone(accountId: string, contactKey: string, envelope: string): string {
  const parts = typeof envelope === "string" ? envelope.split(".") : [];
  if (parts.length !== 5 || parts[0] !== VERSION || !KEY_ID_PATTERN.test(parts[1]) || !parts.slice(2).every((p) => B64URL.test(p))) {
    throw new PhoneVaultError("bad_envelope");
  }
  const current = currentKey();
  if (!current) throw new PhoneVaultError("key_missing");
  const [, keyId, ivPart, tagPart, ctPart] = parts;
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new PhoneVaultError("decrypt_failed");
  const candidates: Buffer[] = [];
  if (keyId === current.id) candidates.push(current.key);
  const prev = parseKey(process.env[CONTACT_ENC_KEY_PREV_ENV]);
  if (prev) candidates.push(prev);
  for (const key of candidates) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(aad(accountId, contactKey));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      // wrong key or tampered value: try the next candidate, then fail below
    }
  }
  throw new PhoneVaultError("decrypt_failed");
}
