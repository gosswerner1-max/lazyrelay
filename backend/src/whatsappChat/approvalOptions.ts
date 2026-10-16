// The buttons of an approval request, and what a tap means. Meta allows at most 3 reply buttons per message, a button id of up to
// 256 characters, and a title of up to 20 characters that is unique within the message (interactive reply buttons reference,
// read 2026-10-16). An approval is a CONVENIENCE RECORD of what a client tapped. It is not legal consent, not a signature and not
// proof of a contract, and the screens say so.

export interface ApprovalOption {
  id: string;
  title: string;
}

export type ApprovalStatus = "pending" | "approved" | "changes_requested" | "question" | "other_reply";

export const MAX_APPROVAL_OPTIONS = 3;
export const MAX_OPTION_TITLE = 20;
export const MAX_OPTION_ID = 256;
export const MAX_APPROVAL_BODY = 1024;
export const MAX_APPROVAL_TITLE = 60;

export const DEFAULT_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: "approve", title: "Approve" },
  { id: "changes", title: "Request changes" },
  { id: "question", title: "Question" },
];

const STATUS_BY_ID: Record<string, Exclude<ApprovalStatus, "pending" | "other_reply">> = { approve: "approved", changes: "changes_requested", question: "question" };

/** What a tap on this option means. Only OUR three ids mean something; any other id is just a reply. */
export function statusForOption(optionId: string): ApprovalStatus {
  return STATUS_BY_ID[optionId] ?? "other_reply";
}

/** The option a tap belongs to: by id first, then (a template quick-reply carries only its text) by title, ignoring case. */
export function matchOption(options: ApprovalOption[], tap: { id: string; title: string }): ApprovalOption | null {
  const byId = options.find((o) => o.id === tap.id);
  if (byId) return byId;
  const title = tap.title.trim().toLowerCase();
  return options.find((o) => o.title.trim().toLowerCase() === title) ?? null;
}
