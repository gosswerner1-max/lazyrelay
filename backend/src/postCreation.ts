// Shared post-creation logic: field validation, the free-tier monthly-post
// limit, and the actual scheduled_posts insert. Extracted out of
// http/routes.ts (2026-08-31) where these lived as nested functions inside
// the route-registration closure -- fine while only routes.ts ever called
// them, but the new Google Calendar inbound-sync poller
// (googleCalendarInboundPoller.ts) needs the exact same validation and
// tier-limit rules a customer's own POST /scheduled-posts goes through, and
// a standalone script can't reach into an Express router's closures. Moved
// here instead of duplicated, so the two callers can never quietly drift
// apart on what "a valid post" or "room under the free tier" means -- the
// same shape of bug this codebase has been bitten by before (see the
// TIER_PRICE_USD / COMPARED_KEYS pattern).
//
// Pure extraction, not a rewrite: every function's behavior is unchanged
// from its original routes.ts version.

import { supabase } from "./supabase.js";
import { isSafeMediaUrl } from "./urlSafety.js";
import { validateMediaForPlatform, type Platform } from "./mediaLimits.js";
import { syncPostToCalendar } from "./googleCalendar/outboundSync.js";
import { syncAccountSheet } from "./googleSheets/outboundSync.js";

/** Free tier: 10 posts per connected account per calendar month. */
export const FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT = 10;

export const MAX_POST_CONTENT_LENGTH = 5000;

export type PostFieldsError = { status: number; body: Record<string, unknown> };
export type PostFieldsOk = {
  account: { id: string; account_id: string; platform: string };
  socialAccountId: string;
  content: string;
  mediaUrl: string | null;
  coverImageUrl: string | null;
  boardId: string | null;
  destinationLink: string | null;
  firstComment: string | null;
  mediaAltText: string | null;
  scheduledFor: string;
};

/** Just the scheduledFor bounds-check, pulled out of validatePostFields
 *  (2026-08-30) so the reschedule route can revalidate a new time without
 *  re-running the rest of validatePostFields' checks — content/account
 *  aren't changing on a reschedule, so re-checking media reachability etc.
 *  would be pointless work and an extra failure surface for a no-op field. */
export function validateScheduledFor(scheduledFor: unknown): PostFieldsError | { scheduledFor: string; scheduledDate: Date } {
  if (typeof scheduledFor !== "string") {
    return { status: 400, body: { error: "scheduledFor must be an ISO date string" } };
  }
  const scheduledDate = new Date(scheduledFor);
  if (Number.isNaN(scheduledDate.getTime())) {
    return { status: 400, body: { error: "scheduledFor must be a valid date" } };
  }
  // Allow "now" and small clock-skew/latency slack rather than a strict
  // future-only check — scheduling for immediate posting is legitimate,
  // and a rigid ">Date.now()" comparison is fragile across a real network
  // hop. Still rejects genuinely stale input (e.g. a client bug sending
  // last year's date).
  const SCHEDULED_FOR_PAST_GRACE_MS = 60_000;
  if (scheduledDate.getTime() < Date.now() - SCHEDULED_FOR_PAST_GRACE_MS) {
    return { status: 400, body: { error: "scheduledFor can't be in the past" } };
  }
  return { scheduledFor, scheduledDate };
}

/** Shared validation for "a real post about to become live-scheduled" —
 *  used by scheduleOnePost's insert path AND the draft-promotion path in
 *  routes.ts, which needs the exact same checks (account ownership,
 *  media-vs-platform compatibility, a real future-ish date) before flipping
 *  a draft to 'pending'. Does NOT do the free-tier monthly-count check (see
 *  checkFreeTierPostLimit below) since a draft promotion and a fresh post
 *  both need it, but at slightly different points in their callers. */
export async function validatePostFields(
  accountId: string | undefined,
  input: { socialAccountId?: unknown; content?: unknown; mediaUrl?: unknown; coverImageUrl?: unknown; boardId?: unknown; destinationLink?: unknown; firstComment?: unknown; mediaAltText?: unknown; scheduledFor?: unknown },
): Promise<PostFieldsError | PostFieldsOk> {
  const { socialAccountId, content, mediaUrl, coverImageUrl, boardId, destinationLink, firstComment, mediaAltText, scheduledFor } = input;
  if (coverImageUrl !== undefined && coverImageUrl !== null && typeof coverImageUrl !== "string") {
    return { status: 400, body: { error: "coverImageUrl must be a string" } };
  }
  // Only meaningful for Pinterest today (see PostRequest.boardId), but
  // accepted/stored generically like coverImageUrl — every other
  // adapter's post() simply ignores it.
  if (boardId !== undefined && boardId !== null && typeof boardId !== "string") {
    return { status: 400, body: { error: "boardId must be a string" } };
  }
  // Only meaningful for Pinterest today (see PostRequest.destinationLink) —
  // same generic-column pattern as boardId.
  if (destinationLink !== undefined && destinationLink !== null && typeof destinationLink !== "string") {
    return { status: 400, body: { error: "destinationLink must be a string" } };
  }
  // Only consumed by adapters that declare postComment (Facebook,
  // Instagram today) — every other adapter's post() simply ignores it,
  // same generic-column pattern as boardId/coverImageUrl.
  if (firstComment !== undefined && firstComment !== null && typeof firstComment !== "string") {
    return { status: 400, body: { error: "firstComment must be a string" } };
  }
  // Only consumed by Mastodon today (see PostRequest.mediaAltText) — every
  // other adapter simply ignores it, same generic-column pattern as above.
  if (mediaAltText !== undefined && mediaAltText !== null && typeof mediaAltText !== "string") {
    return { status: 400, body: { error: "mediaAltText must be a string" } };
  }
  if (!socialAccountId || !content || !scheduledFor) {
    return { status: 400, body: { error: "socialAccountId, content, and scheduledFor are required" } };
  }
  if (typeof socialAccountId !== "string") {
    return { status: 400, body: { error: "socialAccountId must be a string" } };
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    return { status: 400, body: { error: "content must be a non-empty string" } };
  }
  if (content.length > MAX_POST_CONTENT_LENGTH) {
    return { status: 400, body: { error: `content must be ${MAX_POST_CONTENT_LENGTH} characters or fewer` } };
  }
  const scheduledForCheck = validateScheduledFor(scheduledFor);
  if ("status" in scheduledForCheck) {
    return scheduledForCheck;
  }

  // Confirm the social account actually belongs to this caller before
  // scheduling against it — RLS would also catch this at the DB layer,
  // but checking explicitly here gives a clean 403 instead of an opaque
  // insert failure.
  const { data: account, error: accountError } = await supabase
    .from("social_accounts")
    .select("id, account_id, platform")
    .eq("id", socialAccountId)
    .single();
  if (accountError || !account || account.account_id !== accountId) {
    return { status: 403, body: { error: "Social account not found or not owned by this caller" } };
  }

  // Both mediaUrl and coverImageUrl get fetched server-side by whichever
  // platform adapter ends up posting this (scheduler.ts -> adapter.post())
  // — without this check, a customer could point either at an internal
  // address (e.g. cloud metadata) and have LazyRelay's own backend fetch
  // it on their behalf, then read the result back off their own post.
  // Checked here, at write time, so an unsafe URL never even gets
  // scheduled — not deferred to whichever adapter happens to run it.
  if (typeof mediaUrl === "string") {
    const result = await isSafeMediaUrl(mediaUrl);
    if (!result.safe) {
      return { status: 400, body: { error: `mediaUrl ${result.reason}` } };
    }
  }
  if (typeof coverImageUrl === "string") {
    const result = await isSafeMediaUrl(coverImageUrl);
    if (!result.safe) {
      return { status: 400, body: { error: `coverImageUrl ${result.reason}` } };
    }
  }

  // Pre-flight check against the TARGET platform's real requirements —
  // this is what lets a customer find out their file doesn't comply
  // (wrong size, wrong format, wrong aspect ratio) immediately, instead
  // of only discovering it after a scheduled post silently fails later.
  // Uses server-measured metadata from media_uploads, not anything the
  // client claims. See mediaLimits.ts for exactly what is and isn't
  // checked (video duration/resolution aren't yet — needs ffprobe).
  if (mediaUrl) {
    const { data: media } = await supabase
      .from("media_uploads")
      .select("mime_type, size_bytes, width, height")
      .eq("url", mediaUrl)
      .maybeSingle();
    if (media) {
      // account.platform is DB-sourced (the CHECK constraint already
      // limits it to the real platform union), not client input — the
      // cast here is safe now that mediaLimits.ts's Platform type covers
      // all 13 real values, not just 3.
      const result = validateMediaForPlatform(account.platform as Platform, {
        mimeType: media.mime_type,
        sizeBytes: media.size_bytes,
        width: media.width,
        height: media.height,
      });
      if (!result.valid) {
        return { status: 400, body: { error: result.reason } };
      }
    }
  }

  return {
    account,
    socialAccountId,
    content,
    mediaUrl: (mediaUrl as string | undefined) ?? null,
    coverImageUrl: (coverImageUrl as string | undefined) ?? null,
    boardId: (boardId as string | undefined) ?? null,
    destinationLink: (destinationLink as string | undefined) ?? null,
    firstComment: (firstComment as string | undefined) ?? null,
    mediaAltText: (mediaAltText as string | undefined) ?? null,
    scheduledFor: scheduledForCheck.scheduledFor,
  };
}

/** Free tier: 10 posts per connected account per calendar month. Paid
 *  tiers (Pro/Business) in good standing (active or trialing) are
 *  unlimited; past_due/cancelled/no-subscription all fall back to the free
 *  limit — a lapsed payment shouldn't keep unlimited posting. Returns an
 *  error object, or null if there's room. */
export async function checkFreeTierPostLimit(accountId: string | undefined, socialAccountId: string): Promise<PostFieldsError | null> {
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("tier, status")
    .eq("account_id", accountId)
    .maybeSingle();
  const isPaidInGoodStanding = sub?.tier !== "free" && (sub?.status === "active" || sub?.status === "trialing");
  if (isPaidInGoodStanding) return null;

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { count, error: countError } = await supabase
    .from("scheduled_posts")
    .select("id", { count: "exact", head: true })
    .eq("social_account_id", socialAccountId)
    .gte("created_at", startOfMonth);
  if (countError) {
    console.error("[postCreation] checkFreeTierPostLimit:", countError.message);
    return { status: 500, body: { error: "Something went wrong on our end. Please try again." } };
  }
  if ((count ?? 0) >= FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT) {
    return {
      status: 403,
      body: {
        error: `Free tier limit reached: ${FREE_TIER_MONTHLY_POSTS_PER_ACCOUNT} posts per connected account per month. Upgrade to Starter for unlimited posts, or wait until next month.`,
      },
    };
  }
  return null;
}

export async function scheduleOnePost(
  accountId: string | undefined,
  input: { socialAccountId?: unknown; content?: unknown; mediaUrl?: unknown; coverImageUrl?: unknown; boardId?: unknown; destinationLink?: unknown; firstComment?: unknown; mediaAltText?: unknown; scheduledFor?: unknown; requiresApproval?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const validated = await validatePostFields(accountId, input);
  if ("status" in validated) return validated;
  const { socialAccountId, content, mediaUrl, coverImageUrl, boardId, destinationLink, firstComment, mediaAltText, scheduledFor } = validated;

  const limitError = await checkFreeTierPostLimit(accountId, socialAccountId);
  if (limitError) return limitError;

  const { data, error } = await supabase
    .from("scheduled_posts")
    .insert({
      account_id: accountId,
      social_account_id: socialAccountId,
      content,
      media_url: mediaUrl,
      cover_image_url: coverImageUrl,
      board_id: boardId,
      destination_link: destinationLink,
      first_comment: firstComment,
      media_alt_text: mediaAltText,
      scheduled_for: scheduledFor,
      // A post created with requiresApproval sits in needs_approval —
      // invisible to the scheduler (claimDuePosts only ever selects
      // status='pending') — until explicitly approved via
      // PATCH /scheduled-posts/:id/approve.
      status: input.requiresApproval === true ? "needs_approval" : "pending",
    })
    .select()
    .single();
  if (error) {
    console.error("[postCreation] scheduleOnePost insert:", error.message);
    return { status: 500, body: { error: "Something went wrong on our end. Please try again." } };
  }
  // Fire-and-forget: a failed calendar sync must never fail the post
  // itself (see outboundSync.ts's header comment). Covers every caller —
  // the single POST /scheduled-posts route, the bulk-import route, and the
  // Google Calendar inbound-sync poller, which all go through this one
  // function.
  void syncPostToCalendar(data.id);
  void syncAccountSheet(data.account_id);
  return { status: 201, body: data };
}
