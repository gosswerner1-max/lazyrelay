// The switches for WhatsApp broadcasts. Both are OFF unless the environment holds exactly the string "true".
//
//   WHATSAPP_BROADCASTS_ENABLED   contacts, consent, templates and the broadcast screens (also gates Phase 1, see whatsappContacts.routes.ts)
//   WHATSAPP_SEND_ENABLED         the broadcast routes that can create or cancel a send, the sender loop and the status handler
//
// Sending needs the feature on (WHATSAPP_BYOK_ENABLED + WHATSAPP_BROADCASTS_ENABLED) AND WHATSAPP_SEND_ENABLED. These are separate
// from whatsappSendingSupported() in platforms/whatsapp/sendSupport.ts on purpose: that one gates the generic "post to WhatsApp"
// path used by the public API key, the MCP server, Zapier, bulk and duplicate, and it stays false. A broadcast is created only
// through the signed-in dashboard routes in routes/whatsappBroadcasts.routes.ts.

export const BYOK_FLAG = "WHATSAPP_BYOK_ENABLED";
export const BROADCASTS_FLAG = "WHATSAPP_BROADCASTS_ENABLED";
export const SEND_FLAG = "WHATSAPP_SEND_ENABLED";

const on = (name: string): boolean => process.env[name] === "true";

/** The contacts and broadcast feature is on for this deploy. */
export function broadcastsEnabled(): boolean {
  return on(BYOK_FLAG) && on(BROADCASTS_FLAG);
}

/** Sending is on for this deploy: the feature is on and WHATSAPP_SEND_ENABLED is exactly "true". */
export function sendEnabled(): boolean {
  return broadcastsEnabled() && on(SEND_FLAG);
}
