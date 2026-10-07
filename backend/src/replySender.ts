// Draft-first reply loop: the sender. Picks up replies a person APPROVED (replyDrafts.ts), posts them
// through the platform's own reply call, records the platform's answer, and marks each one sent or failed.
//
// Posting publicly under a customer's name cannot be undone, so the rules here are strict:
//   * Only approved drafts are ever sent. Nothing is sent while REPLY_DRAFTS_ENABLED is not "true".
//   * One worker wins each draft (a conditional status change), so two workers or two cycles never send it twice.
//   * A try is repeated only when the failure PROVES nothing was posted (rate limited, the server could not be
//     reached, the service said it was unavailable). A failure that leaves it uncertain (a timeout after the request
//     went out, a server error) is never retried automatically: it becomes "failed" with a note to check the account,
//     because retrying could post the same reply twice. The owner then decides (Try again / Dismiss).
//   * Retries wait 1, 5, 15 and 60 minutes; after 5 tries the draft fails with the last reason.
//   * A send that was started but never finished (the server stopped mid-send) is marked failed the same uncertain
//     way, never sent again by itself.
//   * "Sent" needs an explicit success from the platform, and the platform's own id for the reply is stored with it.
//
// The platform calls, the token loader and the database are passed in, so every branch is tested with fakes.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommentPostResult } from "./platforms/types.js";
import { DRAFTING_PLATFORMS, replyLimitFor } from "./replyDrafting.js";
import {
  claimForSending,
  cleanReplyText,
  failStuckSending,
  listDueApproved,
  markFailed,
  markSent,
  replyDraftsEnabled,
  scheduleRetry,
  textToSend,
  type ReplyDraftRow,
} from "./replyDrafts.js";

type Db = Pick<SupabaseClient, "from">;

export const SENDER_BATCH_SIZE = 10; // drafts handled in one cycle
export const MAX_SENDS_PER_ACCOUNT_PER_CYCLE = 3; // the rest wait for the next cycle
export const MAX_SEND_ATTEMPTS = 5;
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const STUCK_SENDING_MS = 5 * 60_000;
export const MAX_APPROVED_AGE_MS = 24 * 3600_000; // an approved reply not sent within a day is too stale to post
export const SENDABLE_PLATFORMS: readonly string[] = DRAFTING_PLATFORMS;

export type FailureKind = "retry" | "unconfirmed" | "permanent";
export interface ClassifiedFailure {
  kind: FailureKind;
  /** What the owner is told. */
  reason: string;
}

const CANT_REACH = /could not reach|unable to reach|cannot reach|connection refused|econnrefused|enotfound|eai_again|getaddrinfo|dns lookup/i;
const RATE_LIMITED = /rate.?limit|too many requests|slow down|try again in/i;
const UNAVAILABLE = /service unavailable|temporarily unavailable|under maintenance/i;
const UNCERTAIN = /timed? ?out|timeout|etimedout|econnreset|socket hang up|aborted|fetch failed|terminated|network|bad gateway|gateway|internal server error|did not confirm|unexpected end/i;

/**
 * Decides what a failed send means. `phase` says how far the try got: "before_send" means nothing had gone to the
 * platform yet (loading the login, resolving things), so even a timeout is safe to repeat; "during_send" means the
 * request may have reached the platform, so only a clear refusal (rate limit, cannot reach, unavailable) is safe.
 */
export function classifyFailure(message: string, phase: "before_send" | "during_send"): ClassifiedFailure {
  const text = message.trim() || "The reply could not be sent.";
  const code = Number(/\bHTTP (\d{3})\b/i.exec(text)?.[1] ?? 0);

  if (code === 429 || code === 503 || RATE_LIMITED.test(text) || UNAVAILABLE.test(text) || CANT_REACH.test(text)) return { kind: "retry", reason: text };
  if (phase === "before_send" && (UNCERTAIN.test(text) || code >= 500 || code === 408)) return { kind: "retry", reason: text };

  if (code === 408 || code >= 500 || UNCERTAIN.test(text)) {
    return {
      kind: "unconfirmed",
      reason: `LazyRelay could not confirm whether this reply was posted (${text.replace(/[.\s]+$/, "")}). Check your account before trying again, so it is not posted twice.`,
    };
  }
  return { kind: "permanent", reason: text };
}

/** How long to wait after the n-th failed try (1 = after the first). */
export function retryDelayMs(triesSoFar: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(triesSoFar, 1), RETRY_DELAYS_MS.length) - 1];
}

export interface SenderAdapter {
  replyToComment?(commentId: string, text: string, accessToken: string): Promise<CommentPostResult>;
}

export interface SenderDeps<A extends SenderAdapter = SenderAdapter> {
  db: Db;
  getAdapter: (platform: string) => A | undefined;
  /** Loads (and renews if needed) the login for one connected account. Throws when it cannot. */
  getToken: (socialAccountId: string, adapter: A) => Promise<string>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export type SendOutcome = "sent" | "sent_unrecorded" | "retry_scheduled" | "failed" | "failed_unconfirmed" | "lost_race" | "skipped_account_cap";

export interface SenderSummary {
  disabled: boolean;
  stuckFailed: number;
  counts: Partial<Record<SendOutcome, number>>;
  outcomes: { id: string; outcome: SendOutcome }[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SocialRow {
  id: string;
  platform: string;
  disconnected_at: string | null;
  paused_at: string | null;
  needs_reconnect_at: string | null;
  needs_reconnect_reason: string | null;
}

/** Sends one approved draft. Never throws: every path ends with the draft in a final or waiting status. */
async function sendOne<A extends SenderAdapter>(deps: SenderDeps<A>, row: ReplyDraftRow, now: Date): Promise<SendOutcome> {
  const claimed = await claimForSending(deps.db, row.id);
  if (!claimed) return "lost_race"; // another worker took it, or a person changed it
  const attempts = (row.send_attempts ?? 0) + 1;
  let phase: "before_send" | "during_send" = "before_send";

  const stop = async (reason: string): Promise<SendOutcome> => {
    await markFailed(deps.db, row.id, reason, attempts);
    return "failed";
  };

  // `thrown` = the platform call blew up instead of answering. Once the request may have gone out, an error nobody
  // recognised could be a bug AFTER the reply was posted, so it is treated as uncertain, never as a plain refusal.
  const handleFailure = async (message: string, thrown = false): Promise<SendOutcome> => {
    let c = classifyFailure(message, phase);
    if (thrown && phase === "during_send" && c.kind === "permanent") {
      c = { kind: "unconfirmed", reason: `LazyRelay could not confirm whether this reply was posted (${message.replace(/[.\s]+$/, "")}). Check your account before trying again, so it is not posted twice.` };
    }
    if (c.kind === "unconfirmed") {
      await markFailed(deps.db, row.id, c.reason, attempts);
      return "failed_unconfirmed";
    }
    if (c.kind === "retry") {
      if (attempts >= MAX_SEND_ATTEMPTS) {
        await markFailed(deps.db, row.id, `Could not send after ${attempts} tries. Last problem: ${c.reason}`, attempts);
        return "failed";
      }
      await scheduleRetry(deps.db, row.id, attempts, new Date(now.getTime() + retryDelayMs(attempts)), c.reason);
      return "retry_scheduled";
    }
    return stop(c.reason);
  };

  try {
    if (row.decided_at && now.getTime() - Date.parse(row.decided_at) > MAX_APPROVED_AGE_MS) {
      return await stop("This reply was approved too long ago to post now. Dismiss it, or try again if it is still relevant.");
    }
    const text = textToSend(claimed);
    const cleaned = text === null ? null : cleanReplyText(text);
    if (!cleaned || !cleaned.ok) return await stop("This reply has no text to send.");

    const { data } = await deps.db
      .from("social_accounts")
      .select("id, platform, disconnected_at, paused_at, needs_reconnect_at, needs_reconnect_reason")
      .eq("id", row.social_account_id)
      .eq("account_id", row.account_id)
      .maybeSingle();
    const social = data as unknown as SocialRow | null;
    if (!social || social.disconnected_at) return await stop("This account is no longer connected. Reconnect it, then try again.");
    if (social.needs_reconnect_at) return await stop(social.needs_reconnect_reason || "This account needs to be reconnected before replies can be sent.");
    if (social.paused_at) return await stop("This account is paused. Unpause it, then try again.");
    if (!SENDABLE_PLATFORMS.includes(social.platform)) return await stop("Sending replies is not switched on for this platform yet.");
    if (cleaned.text.length > replyLimitFor(social.platform)) return await stop(`This reply is longer than ${social.platform} allows (${replyLimitFor(social.platform)} characters).`);

    const adapter = deps.getAdapter(social.platform);
    if (!adapter?.replyToComment) return await stop("Replying is not supported on this platform.");

    const token = await deps.getToken(social.id, adapter);

    phase = "during_send";
    const result = await adapter.replyToComment(row.platform_comment_id, cleaned.text, token);
    if (!result.success) return await handleFailure(result.errorMessage ?? "The platform did not accept the reply.");

    // The reply IS posted from here on. Recording it is retried; if even that fails the draft is left in "sending"
    // and the stuck-send sweep marks it uncertain, which is wrong but safe: it is never sent twice.
    for (let i = 0; i < 3; i++) {
      try {
        const recorded = await markSent(deps.db, row.id, result.platformReplyId ?? null, attempts);
        if (recorded) return "sent";
        break;
      } catch (err) {
        console.error(`[replySender] could not record a posted reply for draft ${row.id} (try ${i + 1}):`, errorText(err));
      }
    }
    console.error(`[replySender] reply for draft ${row.id} WAS POSTED (platform id ${result.platformReplyId ?? "unknown"}) but could not be recorded as sent`);
    return "sent_unrecorded";
  } catch (err) {
    return handleFailure(errorText(err), true).catch((inner) => {
      console.error(`[replySender] could not record a failure for draft ${row.id}:`, errorText(inner));
      return "failed" as SendOutcome;
    });
  }
}

/**
 * One pass of the sender (index.ts runs it every 30 seconds): marks stuck sends as uncertain, then sends the approved
 * drafts that are due, a few per account, one after another. Never throws.
 */
export async function runReplySenderCycle<A extends SenderAdapter>(deps: SenderDeps<A>): Promise<SenderSummary> {
  const summary: SenderSummary = { disabled: false, stuckFailed: 0, counts: {}, outcomes: [] };
  if (!replyDraftsEnabled(deps.env)) return { ...summary, disabled: true };
  const now = (deps.now ?? (() => new Date()))();
  const note = (id: string, outcome: SendOutcome) => {
    summary.counts[outcome] = (summary.counts[outcome] ?? 0) + 1;
    summary.outcomes.push({ id, outcome });
  };

  try {
    summary.stuckFailed = await failStuckSending(deps.db, STUCK_SENDING_MS, now);
    const due = await listDueApproved(deps.db, now, SENDER_BATCH_SIZE * 3);
    const perAccount = new Map<string, number>();
    let handled = 0;
    for (const row of due) {
      if (handled >= SENDER_BATCH_SIZE) break;
      const used = perAccount.get(row.account_id) ?? 0;
      if (used >= MAX_SENDS_PER_ACCOUNT_PER_CYCLE) {
        note(row.id, "skipped_account_cap");
        continue;
      }
      perAccount.set(row.account_id, used + 1);
      handled += 1;
      note(row.id, await sendOne(deps, row, now));
    }
  } catch (err) {
    console.error("[replySender] cycle failed:", errorText(err));
  }
  return summary;
}
