// Pure helpers for the WhatsApp message viewer: grouping the messages the backend returns into conversations, the labels,
// and the triage badges. No phone number is ever stored by the backend (a conversation is a keyed hash plus a mask such as
// "+27 ** *** 1111"), and nothing here tries to rebuild one: if a mask or a name still looks like a long run of digits,
// it is replaced rather than shown.

import type { WhatsAppMessage } from "./api";

export interface WhatsAppThread {
  contactKey: string;
  /** What the list shows: the profile name plus the masked number, never a raw number. */
  label: string;
  /** The masked number on its own (or a plain placeholder). */
  display: string;
  latestAt: string;
  latestText: string;
  count: number;
  needsAttention: boolean;
  /** Oldest to newest. */
  messages: WhatsAppMessage[];
}

export const UNKNOWN_CONTACT = "Unknown contact";
/** Seven or more digits in a row (spaces, dashes and dots between them included) look like a real number. */
const LONG_DIGIT_RUN = /(?:\d[\s().-]?){7,}/;

/** The masked number, or a placeholder when it is missing or does not look like a mask. */
export function safeDisplay(contactDisplay: string | null | undefined): string {
  const d = (contactDisplay ?? "").trim();
  if (!d || LONG_DIGIT_RUN.test(d)) return UNKNOWN_CONTACT;
  return d;
}

/** The profile name, or null when it is empty or is itself a long number. */
export function safeName(contactName: string | null | undefined): string | null {
  const n = (contactName ?? "").trim();
  if (!n || LONG_DIGIT_RUN.test(n)) return null;
  return n;
}

export function threadLabel(m: Pick<WhatsAppMessage, "contactName" | "contactDisplay">): string {
  const name = safeName(m.contactName);
  const display = safeDisplay(m.contactDisplay);
  return name ? `${name} (${display})` : display;
}

const byTimeAsc = (a: WhatsAppMessage, b: WhatsAppMessage) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.id < b.id ? -1 : 1);

/** Groups by contactKey, newest conversation first; messages inside a conversation run oldest to newest. Duplicate ids
 *  (the same message seen on two pages) count once. */
export function groupThreads(messages: WhatsAppMessage[]): WhatsAppThread[] {
  const seen = new Set<string>();
  const groups = new Map<string, WhatsAppMessage[]>();
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const list = groups.get(m.contactKey);
    if (list) list.push(m);
    else groups.set(m.contactKey, [m]);
  }
  const threads: WhatsAppThread[] = [];
  for (const [contactKey, list] of groups) {
    const sorted = [...list].sort(byTimeAsc);
    const latest = sorted[sorted.length - 1];
    // the label comes from the newest message that has a usable name, else from the newest message
    const named = [...sorted].reverse().find((m) => safeName(m.contactName)) ?? latest;
    threads.push({
      contactKey,
      label: threadLabel({ contactName: named.contactName, contactDisplay: latest.contactDisplay }),
      display: safeDisplay(latest.contactDisplay),
      latestAt: latest.receivedAt,
      latestText: latest.text,
      count: sorted.length,
      needsAttention: sorted.some((m) => m.needsAttention === true),
      messages: sorted,
    });
  }
  return threads.sort((a, b) => (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : a.contactKey < b.contactKey ? -1 : 1));
}

const CATEGORY_LABELS: Record<string, string> = {
  angry_customer: "Upset customer",
  sales_question: "Sales question",
  question: "Question",
  routine: "Routine",
};

export interface TriageBadge {
  text: string;
  /** Drives the badge colour only; the words carry the meaning. */
  tone: "attention" | "info" | "quiet";
}

/** Badges for one message, or none when the backend sent no triage fields (AI sorting off). */
export function triageBadges(m: Pick<WhatsAppMessage, "needsAttention" | "triageCategory">): TriageBadge[] {
  const out: TriageBadge[] = [];
  if (m.needsAttention === true) out.push({ text: "Needs attention", tone: "attention" });
  if (m.triageCategory) {
    const text = CATEGORY_LABELS[m.triageCategory] ?? m.triageCategory.replace(/_/g, " ");
    out.push({ text, tone: m.triageCategory === "routine" ? "quiet" : "info" });
  }
  return out;
}

/** Merges an older page into what is already loaded (by id), keeping everything once. */
export function mergeMessages(current: WhatsAppMessage[], more: WhatsAppMessage[]): WhatsAppMessage[] {
  const ids = new Set(current.map((m) => m.id));
  return [...current, ...more.filter((m) => !ids.has(m.id))];
}
