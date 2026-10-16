// Meta's customer-service window. When a WhatsApp user messages the business (or calls), a 24 hour window opens; each new message
// from them resets it to 24 hours. Inside it the business may send free-form "service messages" (text, interactive reply buttons,
// lists); outside it ONLY an approved template. Source: Meta's "Service messages" page (see docs/whatsapp-phase2-pr-notes.md).
//
// Our record of the window is the time of the person's last inbound message (whatsapp_conversations.last_inbound_at). An unreadable
// or implausible time counts as CLOSED: the safe answer is "use a template".

export const SERVICE_WINDOW_MS = 24 * 3_600_000;
const CLOCK_SKEW_MS = 5 * 60_000;

export interface ServiceWindow {
  open: boolean;
  /** When the window closes (ISO), or null when it is closed. */
  expiresAt: string | null;
  /** Whole hours left, rounded up; 0 when closed. */
  hoursLeft: number;
}

export function serviceWindow(lastInboundAt: string | null | undefined, now: Date = new Date()): ServiceWindow {
  const closed: ServiceWindow = { open: false, expiresAt: null, hoursLeft: 0 };
  if (!lastInboundAt) return closed;
  const last = new Date(lastInboundAt).getTime();
  if (Number.isNaN(last) || last > now.getTime() + CLOCK_SKEW_MS) return closed;
  const expires = last + SERVICE_WINDOW_MS;
  if (now.getTime() >= expires) return closed;
  return { open: true, expiresAt: new Date(expires).toISOString(), hoursLeft: Math.ceil((expires - now.getTime()) / 3_600_000) };
}
