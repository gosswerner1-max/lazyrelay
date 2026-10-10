// WhatsApp "bring your own key": the pieces the Custom Developer Keys panel and its tests share. Mirrors lib/xByok.ts.
// The backend (routes/whatsappByok.routes.ts) is the authority on who may connect and on every value's format; the
// checks here only save a round trip and keep obviously wrong input out of the request.

/** The consent the customer must tick before their credentials are sent. BYTE FOR BYTE what Werner approved
 *  (2026-10-10): straight apostrophe, no extra spaces. Used by the component and by its test; change it nowhere else. */
export const WHATSAPP_BYOK_CONSENT_TEXT =
  "I understand that custom WhatsApp messaging requires active payment credentials linked directly to my Meta Business portfolio. All conversational template billing is handled by Meta directly. I accept full responsibility for compliance with Meta's Business Policies.";

/** Meta ids (WhatsApp Business Account id, phone number id) are numeric strings. Same rule as the backend and its
 *  database CHECK (migration 0124). */
export const META_ID_PATTERN = /^[0-9]{5,25}$/;
/** Same shape rule as the backend: letters, digits, dot, dash, underscore; loose length. */
export const WHATSAPP_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;
export const WHATSAPP_TOKEN_MIN_LENGTH = 20;
export const WHATSAPP_TOKEN_MAX_LENGTH = 512;

export interface WhatsAppFields {
  wabaId: string;
  phoneNumberId: string;
  systemUserToken: string;
}

export const EMPTY_WHATSAPP_FIELDS: WhatsAppFields = { wabaId: "", phoneNumberId: "", systemUserToken: "" };

/** One short, plain-language problem per wrong field (empty object when all three look right). A field the customer
 *  has not typed into yet is not reported: only wrong input is. */
export function whatsAppFieldErrors(f: WhatsAppFields): Partial<Record<keyof WhatsAppFields, string>> {
  const out: Partial<Record<keyof WhatsAppFields, string>> = {};
  const waba = f.wabaId.trim();
  const phone = f.phoneNumberId.trim();
  const token = f.systemUserToken.trim();
  if (waba && !META_ID_PATTERN.test(waba)) out.wabaId = "This should be the numeric ID from Meta: digits only, no spaces.";
  if (phone && !META_ID_PATTERN.test(phone)) out.phoneNumberId = "This should be the numeric Phone number ID from Meta, not the phone number itself.";
  if (token && (token.length < WHATSAPP_TOKEN_MIN_LENGTH || token.length > WHATSAPP_TOKEN_MAX_LENGTH || !WHATSAPP_TOKEN_PATTERN.test(token))) {
    out.systemUserToken = "This does not look like a whole system user token. Copy it again without spaces.";
  }
  return out;
}

/** All three filled in AND well formed. */
export function whatsAppFieldsComplete(f: WhatsAppFields): boolean {
  const filled = f.wabaId.trim() && f.phoneNumberId.trim() && f.systemUserToken.trim();
  return Boolean(filled) && Object.keys(whatsAppFieldErrors(f)).length === 0;
}

/** What a platform card says when THIS account's plan does not include the feature. The backend decides
 *  (GET /platforms: allowed, requiresPlan); the UI only reflects it. */
export function upgradeNote(info: { requiresPlan?: string }): string {
  return `Available on the ${info.requiresPlan ?? "higher"} plan and above.`;
}
