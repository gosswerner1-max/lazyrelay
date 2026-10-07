// Draft-first reply loop: the review routes (what the dashboard's "Suggested replies" screen calls).
//
//   GET  /mentions/drafts               the drafts of this account that still need a decision
//   POST /mentions/drafts/:id/approve   approve one, optionally with the owner's own wording
//   POST /mentions/drafts/:id/discard   throw one away (also dismisses a reply that could not be sent)
//   POST /mentions/drafts/:id/retry     try a reply that could not be sent again
//
// Approving does not post by itself: it marks the draft approved and the sender (replySender.ts, run by
// index.ts every 30 seconds) posts it. The list also carries the replies that could not be sent (so the owner can
// try again or dismiss them) and how many approved replies are still waiting to go out.
//
// While REPLY_DRAFTS_ENABLED is not "true" the list answers { enabled: false, drafts: [] } (so the
// dashboard shows nothing) and the two POST routes answer 404. The table is service-role only, so
// every query here uses the service-role client and is scoped by account_id by hand. Approve and
// discard are human-only (a dashboard sign-in, never an API key) and record which person decided.
// Not listed in the OpenAPI document on purpose (it never advertises what needs a signed-in person).

import { Router } from "express";
import { supabase } from "../../supabase.js";
import { requireAuth, requireHumanAuth, requireJwtUser, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import {
  approveDraft,
  countWaitingToSend,
  discardDraft,
  listDraftsAwaitingReview,
  listFailedSends,
  replyDraftsEnabled,
  retryFailedDraft,
  textToSend,
  type ReplyDraftRow,
} from "../../replyDrafts.js";
import { replyLimitFor } from "../../replyDrafting.js";
import { dbError } from "./shared.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReplyDraftView {
  id: string;
  status: "pending_review" | "needs_input";
  triageCategory: string;
  /** What the model suggested. Null for a "needs input" row: there is no suggestion, the owner writes the reply. */
  draftText: string | null;
  /** The longest reply this platform accepts (the dashboard shows a counter against it). */
  replyLimit: number;
  createdAt: string;
  expiresAt: string;
  post: { id: string; platform: string; content: string; url: string | null } | null;
  comment: { id: string; author: string; text: string; url: string | null; createdAt: string | null };
}

interface PostRow {
  id: string;
  content: string;
  social_accounts: { platform?: string } | { platform?: string }[] | null;
  post_results: { platform_post_url: string | null; verified_live: boolean }[] | null;
}
interface CommentRow {
  scheduled_post_id: string;
  platform_comment_id: string;
  author: string;
  text: string;
  url: string | null;
  comment_created_at: string | null;
}

/** Joins each draft with the post it is on and the comment it answers, for the review screen. */
export function toReplyDraftViews(drafts: ReplyDraftRow[], posts: PostRow[], comments: CommentRow[]): ReplyDraftView[] {
  const postById = new Map(posts.map((p) => [p.id, p]));
  const commentByKey = new Map(comments.map((c) => [`${c.scheduled_post_id}:${c.platform_comment_id}`, c]));
  return drafts
    .filter((d): d is ReplyDraftRow & { status: "pending_review" | "needs_input" } => d.status === "pending_review" || d.status === "needs_input")
    .map((d) => {
      const post = postById.get(d.scheduled_post_id) ?? null;
      const comment = commentByKey.get(`${d.scheduled_post_id}:${d.platform_comment_id}`);
      const social = post ? (Array.isArray(post.social_accounts) ? post.social_accounts[0] : post.social_accounts) : null;
      const platform = social?.platform ?? "";
      const live = (Array.isArray(post?.post_results) ? post!.post_results : []).find((r) => r.verified_live);
      return {
        id: d.id,
        status: d.status,
        triageCategory: d.triage_category,
        draftText: d.draft_text,
        replyLimit: replyLimitFor(platform),
        createdAt: d.created_at,
        expiresAt: d.expires_at,
        post: post ? { id: post.id, platform, content: post.content, url: live?.platform_post_url ?? null } : null,
        // The comment cache is refreshed by a poller; if the row is gone the screen still shows the draft, flagged as "comment unavailable".
        comment: comment
          ? { id: d.platform_comment_id, author: comment.author, text: comment.text, url: comment.url, createdAt: comment.comment_created_at }
          : { id: d.platform_comment_id, author: "", text: "", url: null, createdAt: null },
      };
    });
}

export interface FailedSendView {
  id: string;
  /** The reply that was meant to go out (the owner's wording if they changed it). */
  replyText: string;
  /** Why it did not go out, in plain words. */
  error: string;
  /** True when LazyRelay cannot tell whether the reply was posted: the owner must look before trying again. */
  uncertain: boolean;
  tries: number;
  decidedAt: string | null;
  post: ReplyDraftView["post"];
  comment: ReplyDraftView["comment"];
}

// The two messages the sender writes when it cannot tell whether a reply was posted (replySender.ts, replyDrafts.ts).
const UNCERTAIN_ERROR = /could not confirm whether this reply was posted|may or may not have been posted/i;

export function toFailedSendViews(drafts: ReplyDraftRow[], posts: PostRow[], comments: CommentRow[]): FailedSendView[] {
  const postById = new Map(posts.map((p) => [p.id, p]));
  const commentByKey = new Map(comments.map((c) => [`${c.scheduled_post_id}:${c.platform_comment_id}`, c]));
  return drafts
    .filter((d) => d.status === "failed")
    .map((d) => {
      const post = postById.get(d.scheduled_post_id) ?? null;
      const comment = commentByKey.get(`${d.scheduled_post_id}:${d.platform_comment_id}`);
      const social = post ? (Array.isArray(post.social_accounts) ? post.social_accounts[0] : post.social_accounts) : null;
      const live = (Array.isArray(post?.post_results) ? post!.post_results : []).find((r) => r.verified_live);
      const error = d.error ?? "The reply could not be sent.";
      return {
        id: d.id,
        replyText: textToSend(d) ?? "",
        error,
        uncertain: UNCERTAIN_ERROR.test(error),
        tries: d.send_attempts ?? 0,
        decidedAt: d.decided_at,
        post: post ? { id: post.id, platform: social?.platform ?? "", content: post.content, url: live?.platform_post_url ?? null } : null,
        comment: comment
          ? { id: d.platform_comment_id, author: comment.author, text: comment.text, url: comment.url, createdAt: comment.comment_created_at }
          : { id: d.platform_comment_id, author: "", text: "", url: null, createdAt: null },
      };
    });
}

export function buildReplyDraftsRouter(): Router {
  const router = Router();

  router.get("/mentions/drafts", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    if (!replyDraftsEnabled()) {
      res.json({ enabled: false, drafts: [], failed: [], waitingToSend: 0 });
      return;
    }
    const accountId = req.accountId!;
    const [{ data: drafts, error }, { data: failedRows, error: failedError }, waitingToSend] = await Promise.all([
      listDraftsAwaitingReview(supabase, accountId),
      listFailedSends(supabase, accountId),
      countWaitingToSend(supabase, accountId),
    ]);
    if (error || failedError) {
      dbError(res, (error ?? failedError)!, "GET /mentions/drafts");
      return;
    }
    if (drafts.length === 0 && failedRows.length === 0) {
      res.json({ enabled: true, drafts: [], failed: [], waitingToSend });
      return;
    }
    const postIds = [...new Set([...drafts, ...failedRows].map((d) => d.scheduled_post_id))];
    const [{ data: posts, error: postsError }, { data: comments, error: commentsError }] = await Promise.all([
      supabase
        .from("scheduled_posts")
        .select("id, content, social_accounts(platform), post_results(platform_post_url, verified_live)")
        .eq("account_id", accountId)
        .in("id", postIds),
      supabase
        .from("mention_comments_cache")
        .select("scheduled_post_id, platform_comment_id, author, text, url, comment_created_at")
        .eq("account_id", accountId)
        .in("scheduled_post_id", postIds),
    ]);
    if (postsError || commentsError) {
      dbError(res, (postsError ?? commentsError)!, "GET /mentions/drafts context");
      return;
    }
    const postRows = (posts ?? []) as unknown as PostRow[];
    const commentRows = (comments ?? []) as unknown as CommentRow[];
    res.json({ enabled: true, drafts: toReplyDraftViews(drafts, postRows, commentRows), failed: toFailedSendViews(failedRows, postRows, commentRows), waitingToSend });
  });

  // Human sign-in only: a reply goes out under the customer's name, so an API key never approves one.
  router.post("/mentions/drafts/:id/approve", requireAuth, requireHumanAuth, requireJwtUser, tieredRateLimit, async (req: AuthedRequest, res) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!replyDraftsEnabled() || !UUID.test(id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const body = (req.body ?? {}) as { editedText?: unknown };
    if (body.editedText !== undefined && body.editedText !== null && typeof body.editedText !== "string") {
      res.status(400).json({ error: "editedText must be text" });
      return;
    }
    const result = await approveDraft(supabase, req.accountId!, id, req.jwtUser!.id, body.editedText as string | null | undefined);
    if (result.ok) {
      res.json({ success: true, status: result.row.status });
      return;
    }
    // not_waiting covers "no such draft for this account" and "already decided": both are a conflict the screen handles by refreshing.
    const status = result.reason === "not_waiting" ? 409 : 400;
    res.status(status).json({ error: result.message });
  });

  router.post("/mentions/drafts/:id/discard", requireAuth, requireHumanAuth, requireJwtUser, tieredRateLimit, async (req: AuthedRequest, res) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!replyDraftsEnabled() || !UUID.test(id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const row = await discardDraft(supabase, req.accountId!, id, req.jwtUser!.id);
    if (!row) {
      res.status(409).json({ error: "This draft is no longer waiting for a decision." });
      return;
    }
    res.json({ success: true, status: row.status });
  });

  // Try a failed send again: back to approved (the tries start again from zero) and the sender picks it up. Human only.
  router.post("/mentions/drafts/:id/retry", requireAuth, requireHumanAuth, requireJwtUser, tieredRateLimit, async (req: AuthedRequest, res) => {
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!replyDraftsEnabled() || !UUID.test(id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const row = await retryFailedDraft(supabase, req.accountId!, id, req.jwtUser!.id);
    if (!row) {
      res.status(409).json({ error: "This reply is no longer waiting to be tried again." });
      return;
    }
    res.json({ success: true, status: row.status });
  });

  return router;
}
