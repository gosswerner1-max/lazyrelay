// Draft-first reply loop: the data layer for the reply_drafts table (migration 0115).
//
// A draft is a suggested reply to a comment, held until a person approves, edits or
// discards it. Nothing here sends anything, and nothing calls this module yet: the
// poller that writes drafts, the review routes and the sender come after it, behind a
// kill switch that is off (replyDraftsEnabled).
//
// The database client is passed in (callers pass the service-role `supabase`), the same
// way mentionsQuery.ts does it, so everything here can be tested without a database.
// Every query that acts on one draft for a customer is scoped by account_id: a draft id
// alone is never enough to reach another account's row.
//
// Status changes are ONE conditional UPDATE ("... WHERE status IN (<expected>)", the
// same claim pattern as webhook.ts): two clicks or two workers cannot both win, the loser
// gets null back. The allowed moves are in TRANSITIONS and are enforced here as well as by
// the table's own check constraints.

import type { SupabaseClient } from "@supabase/supabase-js";

type Db = Pick<SupabaseClient, "from">;

export const REPLY_DRAFT_MAX_LENGTH = 2000; // the reply box's own limit; also a table check
export const REPLY_DRAFT_LIST_LIMIT = 50;
export const FAILURE_REASON_MAX_LENGTH = 300;

export const REPLY_DRAFT_STATUSES = ["pending_review", "needs_input", "approved", "sending", "sent", "failed", "discarded", "expired"] as const;
export type ReplyDraftStatus = (typeof REPLY_DRAFT_STATUSES)[number];

// The triage categories that may get a draft. angry_customer is left out on purpose: money,
// legal, security and angry customers are escalated to the owner, never drafted (the table
// refuses such a row too).
export const DRAFTABLE_CATEGORIES = ["sales_question", "question", "routine"] as const;
export type DraftableCategory = (typeof DRAFTABLE_CATEGORIES)[number];

export interface ReplyDraftRow {
  id: string;
  account_id: string;
  scheduled_post_id: string;
  social_account_id: string;
  platform_comment_id: string;
  source_signature: string;
  triage_category: DraftableCategory;
  status: ReplyDraftStatus;
  draft_text: string | null;
  edited_text: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  sent_at: string | null;
  platform_reply_id: string | null;
  error: string | null;
  /** Tries so far (migration 0116). The sender gives up after MAX_SEND_ATTEMPTS. */
  send_attempts: number;
  /** Not before this moment (waiting out a rate limit); null means "as soon as the sender looks". */
  next_attempt_at: string | null;
}

const COLUMNS =
  "id, account_id, scheduled_post_id, social_account_id, platform_comment_id, source_signature, triage_category, status, draft_text, edited_text, model, created_at, updated_at, expires_at, decided_by, decided_at, sent_at, platform_reply_id, error, send_attempts, next_attempt_at";

// ---- Rules that need no database -------------------------------------------------

/** Kill switch. Drafting and sending run only when REPLY_DRAFTS_ENABLED is exactly "true". */
export function replyDraftsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.REPLY_DRAFTS_ENABLED === "true";
}

export function isDraftableCategory(category: unknown): category is DraftableCategory {
  return typeof category === "string" && (DRAFTABLE_CATEGORIES as readonly string[]).includes(category);
}

export function isReplyDraftStatus(status: unknown): status is ReplyDraftStatus {
  return typeof status === "string" && (REPLY_DRAFT_STATUSES as readonly string[]).includes(status);
}

/** Which statuses a draft may move to from each status. */
export const TRANSITIONS: Record<ReplyDraftStatus, readonly ReplyDraftStatus[]> = {
  pending_review: ["approved", "discarded", "expired"],
  needs_input: ["approved", "discarded", "expired"], // approved only with a text the owner wrote
  approved: ["sending"],
  sending: ["sent", "failed", "approved"], // approved again = a try that provably posted nothing, waiting to be retried
  failed: ["approved", "discarded"], // retry or give up
  sent: [],
  discarded: [],
  expired: [],
};

export function canTransition(from: ReplyDraftStatus, to: ReplyDraftStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type CleanText = { ok: true; text: string } | { ok: false; error: string };

/** Reply text from a person or the model: trimmed, 1 to 2000 characters. */
export function cleanReplyText(value: unknown): CleanText {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, error: "The reply cannot be empty." };
  const text = value.trim();
  if (text.length > REPLY_DRAFT_MAX_LENGTH) return { ok: false, error: `A reply must be ${REPLY_DRAFT_MAX_LENGTH} characters or fewer.` };
  return { ok: true, text };
}

/** The text that would be sent: the owner's edit if there is one, otherwise the draft. Null when neither exists. */
export function textToSend(row: Pick<ReplyDraftRow, "draft_text" | "edited_text">): string | null {
  return row.edited_text ?? row.draft_text;
}

/** A failure reason safe to store and show: one line, no long dashes, at most 300 characters. */
export function cleanFailureReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason : "The reply could not be sent.";
  return text.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().slice(0, FAILURE_REASON_MAX_LENGTH) || "The reply could not be sent.";
}

// ---- Queries ------------------------------------------------------------------------

export interface NewDraft {
  accountId: string;
  scheduledPostId: string;
  socialAccountId: string;
  platformCommentId: string;
  triageCategory: unknown;
  /** The model's reply. Leave out (null) when the facts do not answer the comment: the row is then a "needs input" prompt. */
  draftText: string | null;
  model?: string | null;
}

export type CreateResult =
  | { ok: true; row: ReplyDraftRow }
  | { ok: false; reason: "not_draftable" | "invalid_text" | "duplicate" | "db_error"; message: string };

/** One draft per comment. A second attempt for the same post and comment returns "duplicate", not a second row. */
export async function createDraft(db: Db, input: NewDraft): Promise<CreateResult> {
  if (!isDraftableCategory(input.triageCategory)) {
    return { ok: false, reason: "not_draftable", message: "This kind of comment is escalated to the owner, never drafted." };
  }
  let draftText: string | null = null;
  if (input.draftText !== null) {
    const cleaned = cleanReplyText(input.draftText);
    if (!cleaned.ok) return { ok: false, reason: "invalid_text", message: cleaned.error };
    draftText = cleaned.text;
  }
  const { data, error } = await db
    .from("reply_drafts")
    .insert({
      account_id: input.accountId,
      scheduled_post_id: input.scheduledPostId,
      social_account_id: input.socialAccountId,
      platform_comment_id: input.platformCommentId,
      // The comment id again: comment text never changes after posting (same as comment_triage).
      source_signature: input.platformCommentId,
      triage_category: input.triageCategory,
      status: draftText === null ? "needs_input" : "pending_review",
      draft_text: draftText,
      model: input.model ?? null,
    })
    .select(COLUMNS)
    .single();
  if (error) {
    // 23505 = unique violation: this comment already has a draft.
    if ((error as { code?: string }).code === "23505") return { ok: false, reason: "duplicate", message: "This comment already has a draft." };
    return { ok: false, reason: "db_error", message: error.message };
  }
  return { ok: true, row: data as unknown as ReplyDraftRow };
}

/** The drafts of this account that still need a decision, newest first. */
export async function listDraftsAwaitingReview(db: Db, accountId: string, limit: number = REPLY_DRAFT_LIST_LIMIT) {
  const { data, error } = await db
    .from("reply_drafts")
    .select(COLUMNS)
    .eq("account_id", accountId)
    .in("status", ["pending_review", "needs_input"])
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, REPLY_DRAFT_LIST_LIMIT)));
  return { data: (data ?? []) as unknown as ReplyDraftRow[], error };
}

/** One draft of this account, or null (also when the id belongs to another account). */
export async function getDraft(db: Db, accountId: string, id: string): Promise<ReplyDraftRow | null> {
  const { data } = await db.from("reply_drafts").select(COLUMNS).eq("account_id", accountId).eq("id", id).maybeSingle();
  return (data as unknown as ReplyDraftRow | null) ?? null;
}

interface MoveArgs {
  accountId?: string; // customer-facing moves are always scoped to the account; the sender worker's are by id
  id: string;
  from: readonly ReplyDraftStatus[];
  to: ReplyDraftStatus;
  patch?: Record<string, unknown>;
}

/**
 * Moves one draft from one of the `from` statuses to `to`, only if it is still in one of them.
 * Returns the updated row, or null when it was not (someone else got there first, or it never
 * existed). Throws for a move the status table does not allow: that is a bug in the caller.
 */
export async function moveDraft(db: Db, args: MoveArgs): Promise<ReplyDraftRow | null> {
  for (const from of args.from) {
    if (!canTransition(from, args.to)) throw new Error(`reply_drafts: ${from} -> ${args.to} is not an allowed move`);
  }
  let query = db.from("reply_drafts").update({ ...args.patch, status: args.to }).eq("id", args.id);
  if (args.accountId) query = query.eq("account_id", args.accountId);
  const { data } = await query.in("status", [...args.from]).select(COLUMNS).maybeSingle();
  return (data as unknown as ReplyDraftRow | null) ?? null;
}

export type ApproveResult =
  | { ok: true; row: ReplyDraftRow }
  | { ok: false; reason: "invalid_text" | "no_text" | "not_waiting"; message: string };

/**
 * A person approves a draft, optionally with their own wording. For a "needs input" row the owner's
 * text is required (there is no draft). Approving does not send: the sender picks up approved rows.
 */
export async function approveDraft(db: Db, accountId: string, id: string, decidedBy: string, editedText?: string | null): Promise<ApproveResult> {
  const current = await getDraft(db, accountId, id);
  if (!current || (current.status !== "pending_review" && current.status !== "needs_input")) {
    return { ok: false, reason: "not_waiting", message: "This draft is no longer waiting for a decision." };
  }
  let edited: string | null = current.edited_text;
  if (editedText !== undefined && editedText !== null) {
    const cleaned = cleanReplyText(editedText);
    if (!cleaned.ok) return { ok: false, reason: "invalid_text", message: cleaned.error };
    edited = cleaned.text;
  }
  if (edited === null && current.draft_text === null) {
    return { ok: false, reason: "no_text", message: "Write the reply first: there is no suggested text for this comment." };
  }
  const row = await moveDraft(db, {
    accountId,
    id,
    from: ["pending_review", "needs_input"],
    to: "approved",
    patch: { decided_by: decidedBy, decided_at: new Date().toISOString(), edited_text: edited },
  });
  return row ? { ok: true, row } : { ok: false, reason: "not_waiting", message: "This draft is no longer waiting for a decision." };
}

/** A person discards a draft (or gives up on a failed one). */
export function discardDraft(db: Db, accountId: string, id: string, decidedBy: string) {
  return moveDraft(db, { accountId, id, from: ["pending_review", "needs_input", "failed"], to: "discarded", patch: { decided_by: decidedBy, decided_at: new Date().toISOString() } });
}

/** A person retries a failed send: back to approved, so the sender picks it up again. */
export function retryFailedDraft(db: Db, accountId: string, id: string, decidedBy: string) {
  return moveDraft(db, { accountId, id, from: ["failed"], to: "approved", patch: { decided_by: decidedBy, decided_at: new Date().toISOString(), error: null, send_attempts: 0, next_attempt_at: null } });
}

// ---- The sender worker's side (no account scope: it works through approved rows) ------

/** Takes one approved draft for sending. Null means someone else took it: do not send. */
export function claimForSending(db: Db, id: string) {
  return moveDraft(db, { id, from: ["approved"], to: "sending" });
}

export function markSent(db: Db, id: string, platformReplyId: string | null, attempts?: number) {
  return moveDraft(db, {
    id,
    from: ["sending"],
    to: "sent",
    patch: { sent_at: new Date().toISOString(), platform_reply_id: platformReplyId, error: null, next_attempt_at: null, ...(attempts === undefined ? {} : { send_attempts: attempts }) },
  });
}

/** A try that provably posted nothing: back to approved, to be tried again after `nextAttemptAt`. */
export function scheduleRetry(db: Db, id: string, attempts: number, nextAttemptAt: Date, reason: unknown) {
  return moveDraft(db, {
    id,
    from: ["sending"],
    to: "approved",
    patch: { send_attempts: attempts, next_attempt_at: nextAttemptAt.toISOString(), error: cleanFailureReason(reason) },
  });
}

export function markFailed(db: Db, id: string, reason: unknown, attempts?: number) {
  return moveDraft(db, {
    id,
    from: ["sending"],
    to: "failed",
    patch: { error: cleanFailureReason(reason), next_attempt_at: null, ...(attempts === undefined ? {} : { send_attempts: attempts }) },
  });
}

/** Approved drafts that are due to be sent: no waiting time, or the waiting time has passed. Oldest decision first. */
export async function listDueApproved(db: Db, now: Date, limit: number): Promise<ReplyDraftRow[]> {
  const base = () => db.from("reply_drafts").select(COLUMNS).eq("status", "approved");
  const [fresh, waited] = await Promise.all([
    base().is("next_attempt_at", null).order("decided_at", { ascending: true }).limit(limit),
    base().lte("next_attempt_at", now.toISOString()).order("decided_at", { ascending: true }).limit(limit),
  ]);
  const byId = new Map<string, ReplyDraftRow>();
  for (const row of [...((fresh.data ?? []) as unknown as ReplyDraftRow[]), ...((waited.data ?? []) as unknown as ReplyDraftRow[])]) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => Date.parse(a.decided_at ?? "") - Date.parse(b.decided_at ?? "")).slice(0, limit);
}

/** The owner's approved replies that LazyRelay has not managed to send yet (for the "waiting to be sent" line). */
export async function countWaitingToSend(db: Db, accountId: string): Promise<number> {
  const { count } = await db.from("reply_drafts").select("id", { count: "exact", head: true }).eq("account_id", accountId).in("status", ["approved", "sending"]);
  return count ?? 0;
}

/** The owner's replies that could not be sent, newest decision first, so the screen can offer "try again". */
export async function listFailedSends(db: Db, accountId: string, limit = 20) {
  const { data, error } = await db
    .from("reply_drafts")
    .select(COLUMNS)
    .eq("account_id", accountId)
    .eq("status", "failed")
    .order("decided_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 50)));
  return { data: (data ?? []) as unknown as ReplyDraftRow[], error };
}

// ---- Sweeps (for a periodic task) -----------------------------------------------------

/** Drafts nobody reviewed before their expiry become "expired". Returns how many. */
export async function expireStaleDrafts(db: Db, now: Date = new Date()): Promise<number> {
  const { data } = await db
    .from("reply_drafts")
    .update({ status: "expired" })
    .in("status", ["pending_review", "needs_input"])
    .lt("expires_at", now.toISOString())
    .select("id");
  return ((data ?? []) as unknown[]).length;
}

export const UNCONFIRMED_SEND_MESSAGE =
  "LazyRelay stopped while sending this reply, so it may or may not have been posted. Check your account before trying again, so it is not posted twice.";

/**
 * A draft left in "sending" by a worker that crashed. The platform call may already have gone through, so
 * it is NOT put back to be sent again (that could post the same reply twice): it is marked failed with a
 * note, and a person decides. Returns how many.
 */
export async function failStuckSending(db: Db, stuckMs: number, now: Date = new Date()): Promise<number> {
  const { data } = await db
    .from("reply_drafts")
    .update({ status: "failed", error: UNCONFIRMED_SEND_MESSAGE, next_attempt_at: null })
    .eq("status", "sending")
    .lt("updated_at", new Date(now.getTime() - stuckMs).toISOString())
    .select("id");
  return ((data ?? []) as unknown[]).length;
}
