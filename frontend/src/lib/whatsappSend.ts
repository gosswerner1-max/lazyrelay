// Pure helpers for the WhatsApp broadcast and chat screens. The backend decides everything (routes/whatsappBroadcasts.routes.ts and
// whatsappChat.routes.ts); these only word what it says and check a form before anything is sent. Rules for the wording: plain words,
// no dashes, nothing that claims more than Meta confirmed ("handed to WhatsApp" is not "delivered"), and cost is always an estimate.

export interface WindowState {
  open: boolean;
  expiresAt: string | null;
  hoursLeft: number;
}

export interface CostEstimateView {
  amount: number;
  currency: string;
  isEstimate: true;
}

export function deliveryLine(d: { delivered: number; ofAccepted: number }): string {
  if (d.ofAccepted === 0) return "Nothing has been handed to WhatsApp yet";
  return `${d.delivered} delivered of ${d.ofAccepted}, confirmed by Meta`;
}

export function costLine(c: CostEstimateView | null): string {
  if (!c) return "Add your rate card to see an estimated cost";
  const shown = c.amount > 0 && c.amount < 0.01 ? c.amount.toFixed(4) : c.amount.toFixed(2);
  return `Estimated cost: ${c.currency} ${shown} (from your own rate card, not Meta's bill)`;
}

export function windowLabel(w: WindowState): string {
  if (!w.open) return "Closed, template required";
  return `Open, ${w.hoursLeft} ${w.hoursLeft === 1 ? "hour" : "hours"} left`;
}

export type BroadcastStatus = "scheduled" | "sending" | "completed" | "cancelled" | "paused" | "failed";
const BROADCAST_LABELS: Record<BroadcastStatus, string> = { scheduled: "Scheduled", sending: "Sending", completed: "Finished", cancelled: "Cancelled", paused: "Paused", failed: "Failed" };
export const broadcastStatusLabel = (s: BroadcastStatus): string => BROADCAST_LABELS[s] ?? "Unknown";

const MESSAGE_LABELS: Record<string, string> = { received: "", handed_off: "Handed to WhatsApp", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Not sent" };
export const messageStatusLabel = (s: string): string => MESSAGE_LABELS[s] ?? "";

export type ApprovalStatus = "pending" | "approved" | "changes_requested" | "question" | "other_reply";
const APPROVAL_LABELS: Record<ApprovalStatus, string> = { pending: "Waiting for an answer", approved: "Approved", changes_requested: "Changes requested", question: "Has a question", other_reply: "Replied another way" };
export const approvalStatusLabel = (s: ApprovalStatus): string => APPROVAL_LABELS[s] ?? "Unknown";

const PAUSE_TEXT: Record<string, string> = {
  quality: "Paused because WhatsApp reported a quality problem with this number. Check it in Meta Business Manager, then resume.",
  restricted: "Paused because WhatsApp restricted this number. Check it in Meta Business Manager, then resume.",
  credentials: "Paused because WhatsApp did not accept your access token. Reconnect WhatsApp in Social Platforms.",
  template: "Paused because of a problem with the template. Check it in Meta Business Manager.",
  policy: "Paused because WhatsApp blocked this number for a policy reason. Check it in Meta Business Manager.",
  plan: "Paused because your plan no longer includes WhatsApp.",
  connection_unavailable: "Paused because the WhatsApp connection is not available. Check it in Social Platforms.",
  connection_paused: "Paused because this number is paused. Resume it once the problem is fixed.",
  template_unusable: "Paused because the template is no longer approved. Check it in Meta Business Manager and sync your templates.",
};
export const pauseReasonText = (reason: string | null | undefined): string => PAUSE_TEXT[reason ?? ""] ?? "Paused. Check your WhatsApp connection.";

/** A datetime-local value ("2026-10-20T09:30", the browser's own time zone) as an ISO time, or null when it is not a date. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface BroadcastForm {
  connectionId: string;
  templateId: string;
  name: string;
  params: string[];
  variableCount: number;
  scheduledLocal: string;
}
export type BroadcastErrors = Partial<Record<"template" | "name" | "params" | "schedule", string>>;

const MIN_LEAD_MS = 60_000;
const MAX_LEAD_MS = 30 * 24 * 3_600_000;

/** The same rules the server applies, so a person sees what is wrong before sending anything. The server stays the authority. */
export function validateBroadcast(f: BroadcastForm, nowMs: number = Date.now()): BroadcastErrors {
  const errors: BroadcastErrors = {};
  if (!f.templateId) errors.template = "Pick an approved template.";
  const name = f.name.trim();
  if (name === "" || name.length > 80 || /\d{7,}/.test(name.replace(/[\s().+-]/g, ""))) errors.name = "Give the broadcast a short name that is not a phone number.";
  if (f.params.length !== f.variableCount || f.params.some((p) => p.trim() === "")) errors.params = f.variableCount === 0 ? undefined : `Fill in all ${f.variableCount} value${f.variableCount === 1 ? "" : "s"}.`;
  if (!errors.params) delete errors.params;
  const iso = localInputToIso(f.scheduledLocal);
  if (!iso) errors.schedule = "Pick a date and time.";
  else {
    const at = new Date(iso).getTime();
    if (at < nowMs + MIN_LEAD_MS || at > nowMs + MAX_LEAD_MS) errors.schedule = "Pick a time between 1 minute and 30 days from now.";
  }
  return errors;
}

/** User-facing wording kept in one place so it can be checked (no dashes, no unproven claims). */
export const COPY = {
  sendingIntro: "Chat with your contacts, send approval requests and schedule broadcasts, all through your own Meta account.",
  approvalNote: "An approval is a convenience record of what your client tapped in WhatsApp. It is not legal consent, a signature or proof of a contract.",
  handedOffNote: "Handed to WhatsApp means Meta accepted the message. It is only counted as delivered when Meta says so.",
  windowNote: "WhatsApp lets you type freely for 24 hours after your contact last wrote to you. After that you can only send an approved template.",
  optOutNote: "Anyone who opted out is skipped automatically, every time.",
  usNote: "Meta does not deliver marketing templates to US (+1) numbers, so those contacts are left out of marketing broadcasts.",
  estimateNote: "Costs are an estimate from the prices you enter. Meta's own bill is the real figure.",
  noTemplates: "No templates yet. Create and get a template approved in Meta Business Manager, then choose Sync templates.",
  unknownPerson: "This person messaged you first. You can reply while the 24 hour window is open. They are not saved as a contact.",
} as const;
