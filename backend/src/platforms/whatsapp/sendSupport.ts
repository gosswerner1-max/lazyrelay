// WhatsApp sending is not built (adapter.ts: post() never calls Meta). A WhatsApp "post" would be a business-initiated
// message, and outside a 24 hour customer-service window Meta only accepts an approved message TEMPLATE, which LazyRelay
// has no model for yet. Until it does, a post aimed at a WhatsApp connection is refused up front (post creation, HTTP 400)
// and, for any row that still gets through (written straight to the database, or a recurring row), failed once in the
// scheduler without ever reaching the adapter.
//
// ONE switch, one place: when sending is built, flip whatsappSendingSupported() and both layers stand down together.

/** The fixed customer-facing text, with a plain hyphen. Exactly this string, everywhere. */
export const WHATSAPP_SEND_NOT_SUPPORTED_MESSAGE = "Not supported yet - requires approved Meta template models";

/** The machine-readable code on the HTTP 400 body and in post_results.raw_error_message. */
export const WHATSAPP_SEND_NOT_SUPPORTED_CODE = "whatsapp_send_not_supported";

/** False until WhatsApp sending (template messages) exists. A function, not a constant, so a test can flip it. */
export function whatsappSendingSupported(): boolean {
  return false;
}

/** True when a post aimed at this platform must be refused or failed now. */
export function isWhatsappSendBlocked(platform: string | null | undefined): boolean {
  return platform === "whatsapp" && !whatsappSendingSupported();
}

/** The HTTP 400 body for the creation guard. */
export function whatsappSendBlockedBody(): { error: string; code: string } {
  return { error: WHATSAPP_SEND_NOT_SUPPORTED_MESSAGE, code: WHATSAPP_SEND_NOT_SUPPORTED_CODE };
}
