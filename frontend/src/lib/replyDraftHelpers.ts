// Small rules for the "Suggested replies" screen, kept apart from the component so they can be tested.

import type { ReplyDraft } from "./api";

export const CATEGORY_LABELS: Record<string, string> = {
  sales_question: "Sales question",
  question: "Question",
  routine: "Routine",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? "Comment";
}

export interface Wording {
  /** Characters the backend will count: the text without spaces at either end. */
  count: number;
  limit: number;
  empty: boolean;
  over: boolean;
}

export function wordingState(text: string, limit: number): Wording {
  const count = text.trim().length;
  return { count, limit, empty: count === 0, over: count > limit };
}

/** The text shown in the box: what the owner typed, otherwise the suggestion, otherwise nothing. */
export function currentText(draft: Pick<ReplyDraft, "id" | "draftText">, typed: Record<string, string>): string {
  return typed[draft.id] ?? draft.draftText ?? "";
}

/** Approve is allowed when there is text and it fits the platform. */
export function canApprove(draft: Pick<ReplyDraft, "id" | "draftText" | "replyLimit">, typed: Record<string, string>): boolean {
  const w = wordingState(currentText(draft, typed), draft.replyLimit);
  return !w.empty && !w.over;
}

/**
 * What to send as editedText: nothing when the owner kept the suggestion exactly as written (approve as suggested),
 * otherwise their own trimmed text. A "needs input" draft has no suggestion, so its text always counts as the owner's.
 */
export function editedTextToSend(draft: Pick<ReplyDraft, "id" | "draftText">, typed: Record<string, string>): string | null {
  const text = currentText(draft, typed).trim();
  if (text === "") return null;
  if (draft.draftText !== null && text === draft.draftText.trim()) return null;
  return text;
}

/** "Expires today", "Expires tomorrow", "Expires in 5 days" (drafts nobody reviews go stale after a week). */
export function expiryLabel(expiresAt: string, now: Date = new Date()): string {
  const ms = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "Expired";
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${days} days`;
}

/** A post's text cut short for the "On your post" line. */
export function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
