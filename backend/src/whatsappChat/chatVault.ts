// Encrypts what a conversation holds that must not sit in a table in the clear: message bodies and approval titles. It is the same
// AES-256-GCM envelope and the same keys as the contact numbers (platforms/whatsapp/phoneVault.ts: WHATSAPP_CONTACT_ENC_KEY, its id,
// and the rotation key). The envelope is bound (AAD) to the account and to the place the value belongs to, so a value copied onto
// another conversation or account does not decrypt. No usable key means refuse: never plain text, never a fallback key.
//
// A conversation's NUMBER is encrypted with encryptPhone/decryptPhone directly, bound to (account, contact key), exactly like a
// stored contact's.

import { decryptPhone, encryptPhone } from "../platforms/whatsapp/phoneVault.js";

/** The envelope functions are generic strings-in, strings-out; only their name says "phone". The second argument is the binding. */
export function encryptBody(accountId: string, conversationId: string, text: string): string {
  return encryptPhone(accountId, `body|${conversationId}`, text);
}
export function decryptBody(accountId: string, conversationId: string, envelope: string): string {
  return decryptPhone(accountId, `body|${conversationId}`, envelope);
}
export function encryptTitle(accountId: string, conversationId: string, text: string): string {
  return encryptPhone(accountId, `title|${conversationId}`, text);
}
export function decryptTitle(accountId: string, conversationId: string, envelope: string): string {
  return decryptPhone(accountId, `title|${conversationId}`, envelope);
}
