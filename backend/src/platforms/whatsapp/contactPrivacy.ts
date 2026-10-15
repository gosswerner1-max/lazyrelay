// How a WhatsApp contact's phone number is kept: never. Three derived values are stored instead, so a thread can be
// grouped and shown without the number ever sitting in a table or a log.
//
//   contact_key      hex HMAC-SHA256 of the number's digits, keyed by the server secret WHATSAPP_CONTACT_HASH_KEY and
//                    scoped by the LazyRelay account id, so the same person messaging two different customers gets two
//                    unrelated keys (they cannot be joined across accounts). Stable per account, so a thread keeps its
//                    key. NOT reversible without the key, but a phone number has few possibilities, so the key must stay
//                    secret: it is a server setting, never stored with the data. Rotating it makes every old thread key
//                    unmatchable (new messages start new threads); the 30 day retention means old rows disappear anyway.
//   contact_display  a mask such as "+27 ** *** 1111": at most the country code and the last 3 or 4 digits, always with
//                    at least three digits hidden.
//   wamid            Meta's message id is stored as a keyed hash too (message_key below): Meta builds those ids from the
//                    sender's number (base64 inside "wamid."), so keeping one raw would keep the number.
//
// With no key configured nothing is derived and the caller drops the message: it never falls back to an unkeyed hash or
// to the raw value.

import { createHmac } from "node:crypto";

export const CONTACT_HASH_KEY_ENV = "WHATSAPP_CONTACT_HASH_KEY";
const MIN_KEY_LENGTH = 16;

/** The server key, or null when it is unset or too short to mean anything. Read at call time so it can be changed
 *  without a code change. */
export function contactHashKey(): string | null {
  const key = process.env[CONTACT_HASH_KEY_ENV];
  return typeof key === "string" && key.trim().length >= MIN_KEY_LENGTH ? key.trim() : null;
}

function keyed(purpose: string, accountId: string, value: string): string | null {
  const key = contactHashKey();
  if (!key) return null;
  return createHmac("sha256", key).update(`${purpose}\n${accountId}\n${value}`).digest("hex");
}

/** Stable, account-scoped, keyed id of a contact (the digits only). Null when no key is configured. */
export function contactKeyFor(accountId: string, waId: string): string | null {
  return keyed("contact", accountId, waId.replace(/\D/g, ""));
}

/** Keyed, account-scoped form of Meta's message id, used for de-duplication in place of the raw id. */
export function messageKeyFor(accountId: string, wamid: string): string | null {
  return keyed("message", accountId, wamid);
}

/** Country calling codes that are one digit (+1 North America, +7 Russia and Kazakhstan). Every other code is shown as at
 *  most its first two digits, which is never more than the real code. */
export function maskPhone(waId: string): string {
  const digits = waId.replace(/\D/g, "");
  const len = digits.length;
  let head = digits.startsWith("1") || digits.startsWith("7") ? 1 : 2;
  let tail = len >= 10 ? 4 : 3;
  // Always at least three digits stay hidden, whatever the length.
  while (head + tail > len - 3 && tail > 0) tail -= 1;
  while (head + tail > len - 3 && head > 0) head -= 1;
  const cc = head > 0 ? `+${digits.slice(0, head)} ` : "";
  const last = tail > 0 ? ` ${digits.slice(len - tail)}` : "";
  return `${cc}** ***${last}`;
}
