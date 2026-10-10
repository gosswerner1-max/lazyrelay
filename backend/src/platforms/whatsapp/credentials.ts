// The customer's own Meta WhatsApp Business credentials, as they are stored: ONE small JSON string in the connection's
// Vault secret (social_accounts.access_token_vault_id, written through store_social_token). The adapter is handed that
// string on every call as the "access token" (the scheduler reads it back from Vault at run time) and parses it, so the
// adapter needs nothing from the server's environment and holds nothing between calls.
//
// The long-lived Meta system user token is the secret. The two Meta ids travel inside the same string so a call is
// self-contained; they are ALSO copied, as plain identifiers, to social_accounts.whatsapp_business_account_id and
// whatsapp_phone_number_id (migration 0124) for display and lookups. The token is never copied anywhere else.
//
// Nothing in here puts a value in an error, a log line or a return the caller could forward: a parse failure says only
// that the login is unusable.

export interface WhatsAppBundle {
  /** Meta system user token (long lived). THE secret. */
  systemUserToken: string;
  /** WhatsApp Business Account id (WABA). Not a secret, useless without the token. */
  wabaId: string;
  /** Phone number id (the id Meta's API takes, not the phone number itself). Not a secret. */
  phoneNumberId: string;
}

/** The code the adapter reports (never the bundle) when it cannot use the stored login. postErrors.ts turns it into
 *  WHATSAPP_NOT_BYOK_MESSAGE. */
export const WHATSAPP_BUNDLE_INVALID_CODE = "whatsapp_byok_bundle_invalid";

/** The code the adapter reports while sending is not built (see adapter.ts). postErrors.ts classifies it as fatal, so
 *  it never retries and never counts toward the platform's circuit breaker. */
export const WHATSAPP_SEND_NOT_BUILT_CODE = "whatsapp_send_not_built";

/** Shown to the customer when a WhatsApp connection does not hold their own credentials (a missing or damaged login).
 *  Fixed text, no values. */
export const WHATSAPP_NOT_BYOK_MESSAGE =
  "This WhatsApp connection does not hold your own Meta credentials. Reconnect WhatsApp with your own Meta credentials in Social Platforms.";

/** Meta ids (WABA id, phone number id) are numeric strings. The same guard is a database CHECK (0124). It also means an
 *  id can be put into a Graph API path without escaping surprises. */
export const META_ID_PATTERN = /^[0-9]{5,25}$/;

/** Strict charset, loose length: Meta does not document a stable format for system user tokens, so only the shape is
 *  enforced. They are letters and digits; the dot, dash and underscore are allowed for safety. */
export const WHATSAPP_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;
export const WHATSAPP_TOKEN_MIN_LENGTH = 20;
export const WHATSAPP_TOKEN_MAX_LENGTH = 512;

export function serializeWhatsAppBundle(bundle: WhatsAppBundle): string {
  return JSON.stringify({ v: 1, systemUserToken: bundle.systemUserToken, wabaId: bundle.wabaId, phoneNumberId: bundle.phoneNumberId });
}

/** Returns the bundle, or null for anything that is not a complete, well formed version 1 bundle. Never throws. */
export function parseWhatsAppBundle(stored: string | null | undefined): WhatsAppBundle | null {
  if (typeof stored !== "string" || !stored.startsWith("{")) return null;
  try {
    const p = JSON.parse(stored) as Record<string, unknown>;
    if (p.v !== 1) return null;
    const { systemUserToken, wabaId, phoneNumberId } = p;
    if (typeof systemUserToken !== "string" || systemUserToken.length < WHATSAPP_TOKEN_MIN_LENGTH || !WHATSAPP_TOKEN_PATTERN.test(systemUserToken)) return null;
    if (typeof wabaId !== "string" || !META_ID_PATTERN.test(wabaId)) return null;
    if (typeof phoneNumberId !== "string" || !META_ID_PATTERN.test(phoneNumberId)) return null;
    return { systemUserToken, wabaId, phoneNumberId };
  } catch {
    return null;
  }
}

/** Display-only masked suffix of the PHONE NUMBER ID (never of the token), at most 8 characters, the column limit. */
export function whatsappKeyHint(phoneNumberId: string): string {
  return `****${phoneNumberId.slice(-4)}`;
}
