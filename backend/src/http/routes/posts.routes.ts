// posts routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.
// Follow-up the same day: hand-written request-body type/length checks
// replaced with zod schemas (see http/validation.ts) — same messages, same
// accept/reject rules, same order.

import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { syncPostToCalendar, deletePostFromCalendar } from "../../googleCalendar/outboundSync.js";
import { syncAccountSheet } from "../../googleSheets/outboundSync.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { scheduleOnePost, validatePostFields, validateScheduledFor, checkFreeTierPostLimit, checkPlatformPostLimit, MAX_POST_CONTENT_LENGTH } from "../../postCreation.js";
import { dbError, resolveBrandFilterSocialAccountIds, fetchAllRows } from "./shared.js";
import { validateBody, nonEmptyString, optionalNullableString, optionalBoolean, unvalidated } from "../validation.js";

// Used to build the public Proof-of-Publish share link returned by
// GET /scheduled-posts/:id/proof-link (see migration
// 0038_proof_link_sharing.sql). No env var for this today — same fixed
// production domain every other public link in this codebase assumes.
const PUBLIC_SITE_URL = "https://lazyrelay.com";

// Deleting a scheduled_posts row never touches the underlying media_uploads
// row/storage file on its own — the same uploaded file can be attached to
// several scheduled posts (e.g. one fan-out schedule to 3 platforms). Only
// reclaim it once nothing else pending/posting still references the URL,
// mirroring DELETE /media/:id's in-use check but firing silently as a
// side-effect of post deletion rather than a user-facing 409.
async function releaseMediaIfOrphaned(mediaUrl: string, accountId: string): Promise<void> {
  const { count: stillInUse } = await supabase
    .from("scheduled_posts")
    .select("id", { count: "exact", head: true })
    .eq("media_url", mediaUrl)
    .in("status", ["pending", "posting"]);
  if ((stillInUse ?? 0) > 0) return;

  const { data: media } = await supabase
    .from("media_uploads")
    .select("id, storage_path")
    .eq("url", mediaUrl)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!media) return;

  if (media.storage_path) {
    await supabase.storage.from("post-media").remove([media.storage_path]);
  }
  await supabase.from("media_uploads").delete().eq("id", media.id);
}

export function buildPostsRouter(): Router {
  const router = Router();

  // Schedule a new post. account_id is taken from the verified JWT, never
  // from the request body — a client can't schedule a post as someone else
  // by passing a different account_id, since requireAuth already resolved
  // who's actually calling.
  //
  // Extracted from the route body so /scheduled-posts/bulk (CSV import) can
  // run the exact same validation/limits per row instead of a parallel,
  // easily-drifting copy. Returns an HTTP-shaped result rather than
  // throwing, since a bulk caller needs to keep going past one bad row.
  router.post("/scheduled-posts", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const result = await scheduleOnePost(req.accountId, req.body ?? {});
    res.status(result.status).json(result.body);
  });

  // Bulk/CSV import — same validation and tier limits as a single post,
  // run per row so one bad row doesn't sink the rest of the batch. The
  // caller (frontend) parses the CSV client-side and posts structured rows
  // here; running rows sequentially (not Promise.all) matters for
  // correctness, not just simplicity — two rows for the same free-tier
  // account racing the same monthly-count check in parallel could both
  // read "9 used" and both insert, silently exceeding the limit.
  const MAX_BULK_POSTS = 200;
  const bulkBodySchema = z.object({
    posts: z
      .array(z.unknown(), { error: "posts must be a non-empty array" })
      .min(1, "posts must be a non-empty array")
      .max(MAX_BULK_POSTS, `A single bulk import is capped at ${MAX_BULK_POSTS} posts — split into smaller batches.`),
  });
  router.post("/scheduled-posts/bulk", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(bulkBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { posts } = body.data;

    const results: Array<{ row: number; status: number; body: Record<string, unknown> }> = [];
    for (let i = 0; i < posts.length; i++) {
      const result = await scheduleOnePost(req.accountId, posts[i] ?? {});
      results.push({ row: i, status: result.status, body: result.body });
    }

    const succeeded = results.filter((r) => r.status === 201).length;
    res.status(200).json({ succeeded, failed: results.length - succeeded, results });
  });

  // Drafts (2026-08-16) — a scheduled_posts row with no committed account or
  // time yet (both nullable as of migration 0049), invisible to the
  // scheduler (claimDuePosts only ever selects status='pending'). Content is
  // the only required field; media/cover/board/first-comment are all
  // optional, same fields a real post accepts, just none of the
  // account/timing validation validatePostFields does — there's nothing to
  // validate against yet.
  // The optional string/boolean fields a draft (and a draft/pending edit via
  // PATCH /scheduled-posts/:id below) accepts, each with the same
  // "<name> must be a string" / "<name> must be a boolean" message the old
  // per-field loops returned.
  const draftStringField = (name: string) => optionalNullableString(`${name} must be a string`);
  const draftBooleanField = (name: string) => optionalBoolean(`${name} must be a boolean`);
  const draftContentField = () =>
    nonEmptyString("content must be a non-empty string").max(
      MAX_POST_CONTENT_LENGTH,
      `content must be ${MAX_POST_CONTENT_LENGTH} characters or fewer`,
    );
  const PLANNED_DATE_ERROR = "plannedDate must be a YYYY-MM-DD string";
  // Deliberately mirrors the old `/regex/.test(plannedDate)` check exactly,
  // including RegExp.test's String() coercion of a non-string — so a value
  // like ["2026-09-01"] still gets past this check (and then fails at the
  // database insert/update), same as before. Tightening this to "strings
  // only" would be a behavior change, so it's flagged, not slipped in here.
  const draftPlannedDateField = () =>
    unvalidated().refine(
      (v) => v === undefined || v === null || /^\d{4}-\d{2}-\d{2}$/.test(v as string),
      PLANNED_DATE_ERROR,
    );
  const SCHEDULED_FOR_ERROR = "scheduledFor must be a valid ISO date string";
  const PLANNED_ACCOUNT_IDS_ERROR = "plannedAccountIds must be an array of strings";
  const draftBodySchema = z.object({
    content: draftContentField(),
    mediaUrl: unvalidated(),
    coverImageUrl: draftStringField("coverImageUrl"),
    boardId: draftStringField("boardId"),
    destinationLink: draftStringField("destinationLink"),
    firstComment: draftStringField("firstComment"),
    mediaAltText: draftStringField("mediaAltText"),
    tiktokPrivacyLevel: draftStringField("tiktokPrivacyLevel"),
    tiktokDisableComment: draftBooleanField("tiktokDisableComment"),
    tiktokDisableDuet: draftBooleanField("tiktokDisableDuet"),
    tiktokDisableStitch: draftBooleanField("tiktokDisableStitch"),
    tiktokBrandOrganic: draftBooleanField("tiktokBrandOrganic"),
    tiktokBrandContent: draftBooleanField("tiktokBrandContent"),
    plannedDate: draftPlannedDateField(),
    scheduledFor: z
      .string({ error: SCHEDULED_FOR_ERROR })
      .refine((s) => !Number.isNaN(new Date(s).getTime()), SCHEDULED_FOR_ERROR)
      .nullish(),
    plannedAccountIds: z
      .array(z.string({ error: PLANNED_ACCOUNT_IDS_ERROR }), { error: PLANNED_ACCOUNT_IDS_ERROR })
      .nullish(),
  });
  router.post("/scheduled-posts/draft", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(draftBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const {
      content,
      mediaUrl,
      coverImageUrl,
      boardId,
      destinationLink,
      firstComment,
      mediaAltText,
      tiktokPrivacyLevel,
      tiktokDisableComment,
      tiktokDisableDuet,
      tiktokDisableStitch,
      tiktokBrandOrganic,
      tiktokBrandContent,
      plannedDate,
      plannedAccountIds,
      scheduledFor,
    } = body.data;
    // Pre-selected platform(s) for this plan item (2026-08-20) — advisory
    // only while status stays 'draft'; ownership is verified here so a
    // customer can't stash an id they don't own, but the real safety check
    // that matters (can this actually be posted) happens again at
    // promotion time via the existing /schedule and POST routes, same as
    // any other post.
    let validatedPlannedAccountIds: string[] | null = null;
    if (plannedAccountIds !== undefined && plannedAccountIds !== null) {
      if (plannedAccountIds.length > 0) {
        const { data: owned, error: ownedError } = await req.db!
          .from("social_accounts")
          .select("id")
          .in("id", plannedAccountIds)
          .eq("account_id", req.accountId);
        if (ownedError) {
          dbError(res, ownedError, "POST /scheduled-posts/draft (plannedAccountIds ownership)");
          return;
        }
        if ((owned ?? []).length !== new Set(plannedAccountIds).size) {
          res.status(403).json({ error: "One or more plannedAccountIds are not owned by this caller" });
          return;
        }
      }
      validatedPlannedAccountIds = plannedAccountIds.length > 0 ? plannedAccountIds : null;
    }
    const { data, error } = await req.db!
      .from("scheduled_posts")
      .insert({
        account_id: req.accountId,
        social_account_id: null,
        content,
        media_url: mediaUrl ?? null,
        cover_image_url: coverImageUrl ?? null,
        board_id: boardId ?? null,
        destination_link: destinationLink ?? null,
        first_comment: firstComment ?? null,
        media_alt_text: mediaAltText ?? null,
        tiktok_privacy_level: tiktokPrivacyLevel ?? null,
        tiktok_disable_comment: tiktokDisableComment ?? true,
        tiktok_disable_duet: tiktokDisableDuet ?? true,
        tiktok_disable_stitch: tiktokDisableStitch ?? true,
        tiktok_brand_organic: tiktokBrandOrganic ?? false,
        tiktok_brand_content: tiktokBrandContent ?? false,
        planned_date: plannedDate ?? null,
        planned_account_ids: validatedPlannedAccountIds,
        scheduled_for: scheduledFor ?? null,
        status: "draft",
      })
      .select()
      .single();
    if (error) {
      dbError(res, error, "POST /scheduled-posts/draft");
      return;
    }
    res.status(201).json(data);
  });

  // Edits a draft in place — only while it's still a draft (status check
  // below). Editing a live pending post's content isn't supported anywhere
  // in this app today (the existing pattern for that is delete + recreate);
  // this route deliberately doesn't change that, it only ever touches rows
  // that are still status='draft'.
  const draftEditBodySchema = z.object({
    content: draftContentField().optional(),
    mediaUrl: draftStringField("mediaUrl"),
    coverImageUrl: draftStringField("coverImageUrl"),
    boardId: draftStringField("boardId"),
    destinationLink: draftStringField("destinationLink"),
    firstComment: draftStringField("firstComment"),
    mediaAltText: draftStringField("mediaAltText"),
    tiktokPrivacyLevel: draftStringField("tiktokPrivacyLevel"),
    tiktokDisableComment: draftBooleanField("tiktokDisableComment"),
    tiktokDisableDuet: draftBooleanField("tiktokDisableDuet"),
    tiktokDisableStitch: draftBooleanField("tiktokDisableStitch"),
    tiktokBrandOrganic: draftBooleanField("tiktokBrandOrganic"),
    tiktokBrandContent: draftBooleanField("tiktokBrandContent"),
    plannedDate: draftPlannedDateField(),
  });
  router.patch("/scheduled-posts/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await req.db!
      .from("scheduled_posts")
      .select("id, status")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "PATCH /scheduled-posts/:id lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    // 'pending' (a real, not-yet-posted scheduled post, not just a draft) was
    // added 2026-09-02 for the update_post MCP tool — the scheduler is the
    // only other thing that moves a 'pending' row (claimDuePosts flips it to
    // 'posting'), so the update below re-checks status atomically in the
    // same query instead of trusting this earlier read, exactly like
    // /reschedule already does for the same race.
    if (existing.status !== "draft" && existing.status !== "pending") {
      res.status(409).json({ error: "Only a draft or a still-pending post can be edited — it's already posting or done." });
      return;
    }

    const body = validateBody(draftEditBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const {
      content,
      mediaUrl,
      coverImageUrl,
      boardId,
      destinationLink,
      firstComment,
      mediaAltText,
      tiktokPrivacyLevel,
      tiktokDisableComment,
      tiktokDisableDuet,
      tiktokDisableStitch,
      tiktokBrandOrganic,
      tiktokBrandContent,
      plannedDate,
    } = body.data;
    const update: Record<string, unknown> = {};
    if (content !== undefined) {
      update.content = content;
    }
    for (const [key, value] of [
      ["media_url", mediaUrl],
      ["cover_image_url", coverImageUrl],
      ["board_id", boardId],
      ["destination_link", destinationLink],
      ["first_comment", firstComment],
      ["media_alt_text", mediaAltText],
      ["tiktok_privacy_level", tiktokPrivacyLevel],
    ] as const) {
      if (value !== undefined) {
        update[key] = value;
      }
    }
    for (const [key, value] of [
      ["tiktok_disable_comment", tiktokDisableComment],
      ["tiktok_disable_duet", tiktokDisableDuet],
      ["tiktok_disable_stitch", tiktokDisableStitch],
      ["tiktok_brand_organic", tiktokBrandOrganic],
      ["tiktok_brand_content", tiktokBrandContent],
    ] as const) {
      if (value !== undefined) {
        update[key] = value;
      }
    }
    if (plannedDate !== undefined) {
      update.planned_date = plannedDate;
    }

    const { data, error, count } = await req.db!
      .from("scheduled_posts")
      .update(update, { count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", existing.status)
      .select()
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /scheduled-posts/:id");
      return;
    }
    if (!count || !data) {
      res.status(409).json({ error: "Only a draft or a still-pending post can be edited — it's already posting or done." });
      return;
    }
    void syncPostToCalendar(data.id);
    void syncAccountSheet(req.accountId!);
    res.json(data);
  });

  // Promotes a draft into a real scheduled post — the same
  // socialAccountId/scheduledFor (and the same validation) a fresh
  // POST /scheduled-posts would need, applied to the existing draft row via
  // UPDATE instead of a new INSERT. Reuses validatePostFields and
  // checkFreeTierPostLimit so a promoted draft counts against the free-tier
  // monthly cap exactly like a brand-new post — it's the same real post,
  // just created a bit earlier.
  router.patch("/scheduled-posts/:id/schedule", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await req.db!
      .from("scheduled_posts")
      .select("id, status")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "PATCH /scheduled-posts/:id/schedule lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "This post has already been scheduled." });
      return;
    }

    const validated = await validatePostFields(req.accountId, req.body ?? {});
    if ("status" in validated) {
      res.status(validated.status).json(validated.body);
      return;
    }
    const {
      socialAccountId,
      content,
      mediaUrl,
      coverImageUrl,
      boardId,
      destinationLink,
      firstComment,
      mediaAltText,
      tiktokPrivacyLevel,
      tiktokDisableComment,
      tiktokDisableDuet,
      tiktokDisableStitch,
      tiktokBrandOrganic,
      tiktokBrandContent,
      scheduledFor,
    } = validated;

    const limitError = await checkFreeTierPostLimit(req.accountId, socialAccountId);
    if (limitError) {
      res.status(limitError.status).json(limitError.body);
      return;
    }

    // Promoting a draft is the moment it starts counting toward a
    // platform's rolling-24h cap (drafts never count) -- the draft itself
    // is excluded, though it wouldn't be counted anyway.
    const platformLimitError = await checkPlatformPostLimit({
      socialAccountId,
      platform: validated.account.platform,
      scheduledFor,
      excludePostId: existing.id,
    });
    if (platformLimitError) {
      res.status(platformLimitError.status).json(platformLimitError.body);
      return;
    }

    const { data, error } = await req.db!
      .from("scheduled_posts")
      .update({
        social_account_id: socialAccountId,
        content,
        media_url: mediaUrl,
        cover_image_url: coverImageUrl,
        board_id: boardId,
        destination_link: destinationLink,
        first_comment: firstComment,
        media_alt_text: mediaAltText,
        tiktok_privacy_level: tiktokPrivacyLevel,
        tiktok_disable_comment: tiktokDisableComment,
        tiktok_disable_duet: tiktokDisableDuet,
        tiktok_disable_stitch: tiktokDisableStitch,
        tiktok_brand_organic: tiktokBrandOrganic,
        tiktok_brand_content: tiktokBrandContent,
        scheduled_for: scheduledFor,
        status: req.body?.requiresApproval === true ? "needs_approval" : "pending",
      })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select()
      .single();
    if (error) {
      dbError(res, error, "PATCH /scheduled-posts/:id/schedule");
      return;
    }
    void syncPostToCalendar(data.id);
    void syncAccountSheet(req.accountId!);
    res.json(data);
  });

  const HISTORY_STATUSES = ["posted", "failed"];
  const SCHEDULED_POSTS_HISTORY_DEFAULT_LIMIT = 50;
  const SCHEDULED_POSTS_HISTORY_MAX_LIMIT = 100;

  // Bounded on purpose: this used to fetch a customer's ENTIRE post
  // history on every dashboard load, with the frontend only ever slicing
  // an already-fully-loaded array for "Load more" — a customer posting a
  // handful of times a day accumulates hundreds of rows within weeks, and
  // every page load kept getting slower forever. "Upcoming" posts
  // (pending/posting/needs_approval, and — 2026-08-16 — draft) are
  // naturally small — they only exist until they fire (or, for a draft,
  // until scheduled/deleted) — so those are always returned in full. History
  // (posted/failed) is capped here to the most recent
  // SCHEDULED_POSTS_HISTORY_DEFAULT_LIMIT; anything older is fetched a
  // page at a time via GET /scheduled-posts/history. Drafts have
  // scheduled_for = null, which Postgres sorts last in ascending order —
  // they naturally land at the end of the upcoming list, after every real
  // scheduled post.
  // Naturally-small assumption above breaks down once one account shares a
  // login across multiple brands (2026-09-14) — a brand filter (same
  // resolveBrandFilterSocialAccountIds() used by /analytics/summary) scopes
  // "upcoming" to the brand the frontend actually asked for.
  //
  // A same-day follow-up found that filter alone wasn't enough: Supabase's
  // own project settings cap every single REST request at 1000 rows no
  // matter what .limit()/.range() the query asks for (confirmed directly —
  // a request for 5000 still came back Content-Range: 0-999/1415). An
  // unfiltered request on an account whose combined post pool exceeds 1000
  // silently lost real posts to this cap, ordered out by date rather than
  // by relevance. The only way past a cap enforced per-request by the
  // platform itself is more requests — fetchAllRows below pages with
  // .range() until a page comes back short of a full page.
  // (SUPABASE_ROW_PAGE_SIZE and fetchAllRows() now live in ./shared.ts — shared with analytics.routes.ts.)

  const SCHEDULED_POSTS_UPCOMING_MAX = 5000;
  router.get("/scheduled-posts", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const brand = typeof req.query.brand === "string" && req.query.brand.length > 0 ? req.query.brand : undefined;
    let matchingSocialAccountIds: string[] | undefined;
    try {
      matchingSocialAccountIds = await resolveBrandFilterSocialAccountIds(req.accountId!, brand);
    } catch (err) {
      dbError(res, err as { message: string }, "GET /scheduled-posts (brand filter)");
      return;
    }

    let upcoming: unknown[];
    try {
      upcoming = await fetchAllRows((from, to) => {
        let q = req
          .db!.from("scheduled_posts")
          .select("*, post_results(*)")
          .eq("account_id", req.accountId)
          .in("status", ["pending", "posting", "needs_approval", "draft"])
          .order("scheduled_for", { ascending: true })
          // Now that every retry attempt (not just verification failures) can
          // leave its own post_results row, the frontend's `post_results?.[0]`
          // needs the MOST RECENT attempt first — without this, a post that
          // failed once and later succeeded on retry could still show its
          // stale first-attempt failure reason instead of the real outcome.
          .order("created_at", { ascending: false, referencedTable: "post_results" });
        if (matchingSocialAccountIds) q = q.in("social_account_id", matchingSocialAccountIds);
        return q.range(from, to);
      }, SCHEDULED_POSTS_UPCOMING_MAX);
    } catch (err) {
      dbError(res, err as { message: string }, "GET /scheduled-posts upcoming");
      return;
    }

    let historyQuery = req.db!
      .from("scheduled_posts")
      .select("*, post_results(*)")
      .eq("account_id", req.accountId)
      .in("status", HISTORY_STATUSES)
      .order("scheduled_for", { ascending: false })
      .order("created_at", { ascending: false, referencedTable: "post_results" })
      .limit(SCHEDULED_POSTS_HISTORY_DEFAULT_LIMIT);
    if (matchingSocialAccountIds) {
      historyQuery = historyQuery.in("social_account_id", matchingSocialAccountIds);
    }
    const { data: history, error: historyError } = await historyQuery;
    if (historyError) {
      dbError(res, historyError, "GET /scheduled-posts history");
      return;
    }
    res.json([...upcoming, ...(history ?? [])]);
  });

  // Additional pages of history, older than `before` (an ISO scheduled_for
  // timestamp — pass the oldest post currently loaded on the frontend).
  // Kept as its own endpoint rather than a page/offset param on the main
  // route above so "Upcoming" never has to be re-fetched just to see more
  // History.
  router.get("/scheduled-posts/history", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || SCHEDULED_POSTS_HISTORY_DEFAULT_LIMIT, 1), SCHEDULED_POSTS_HISTORY_MAX_LIMIT);
    const before = typeof req.query.before === "string" ? req.query.before : undefined;

    let query = req.db!
      .from("scheduled_posts")
      .select("*, post_results(*)")
      .eq("account_id", req.accountId)
      .in("status", HISTORY_STATUSES)
      .order("scheduled_for", { ascending: false })
      .order("created_at", { ascending: false, referencedTable: "post_results" })
      .limit(limit);
    if (before) {
      query = query.lt("scheduled_for", before);
    }

    const { data, error } = await query;
    if (error) {
      dbError(res, error, "GET /scheduled-posts/history");
      return;
    }
    res.json(data ?? []);
  });

  // Flips a needs_approval post to pending, making it eligible for the
  // scheduler. There's no separate "approver" role today (see
  // 0026_scheduled_posts_approval.sql) — anyone authenticated as this
  // account can approve, same as anyone can already edit/delete any post.
  router.patch("/scheduled-posts/:id/approve", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error, count } = await req.db!
      .from("scheduled_posts")
      .update({ status: "pending" }, { count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", "needs_approval")
      .select()
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /scheduled-posts/:id/approve");
      return;
    }
    if (!count || !data) {
      res.status(404).json({ error: "Not found, not owned by this caller, or not awaiting approval" });
      return;
    }
    // 2026-08-30 fix: every other route that changes a post's calendar-
    // relevant state (create, reschedule, delete) calls syncPostToCalendar —
    // this one never did, so an approved post silently never appeared on
    // the customer's Google Calendar even though it's now really scheduled.
    void syncPostToCalendar(data.id);
    void syncAccountSheet(req.accountId!);
    res.json(data);
  });

  // Move an already-pending post to a new day/time — including "post now"
  // (frontend just passes the current time), since claimDuePosts() already
  // polls for status='pending' AND scheduled_for<=now() and
  // validatePostFields already treats "now" as legitimate. There was no way
  // to do this at all before 2026-08-30 — the only previous option was
  // delete + recreate (see the comment on PATCH /scheduled-posts/:id above).
  router.patch("/scheduled-posts/:id/reschedule", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const scheduledForCheck = validateScheduledFor((req.body ?? {}).scheduledFor);
    if ("status" in scheduledForCheck) {
      res.status(scheduledForCheck.status).json(scheduledForCheck.body);
      return;
    }

    const { data: existing, error: fetchError } = await req.db!
      .from("scheduled_posts")
      .select("id, status, paused_at, social_account_id, social_accounts(platform)")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "PATCH /scheduled-posts/:id/reschedule lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    if (existing.status !== "pending") {
      res.status(409).json({ error: "Only a pending post can be rescheduled." });
      return;
    }

    // A platform's rolling-24h cap (platformPostLimits.ts). A paused post
    // isn't counted, so moving it can't break the cap here -- resuming it is
    // re-checked in /resume instead. The post itself is excluded so it never
    // counts against its own new time.
    const socialAccount = Array.isArray(existing.social_accounts) ? existing.social_accounts[0] : existing.social_accounts;
    if (!existing.paused_at && existing.social_account_id && socialAccount?.platform) {
      const platformLimitError = await checkPlatformPostLimit({
        socialAccountId: existing.social_account_id,
        platform: socialAccount.platform,
        scheduledFor: scheduledForCheck.scheduledFor,
        excludePostId: existing.id,
      });
      if (platformLimitError) {
        res.status(platformLimitError.status).json(platformLimitError.body);
        return;
      }
    }

    const { data, error, count } = await req.db!
      .from("scheduled_posts")
      .update(
        {
          scheduled_for: scheduledForCheck.scheduledFor,
          // A rescheduled recurring occurrence is now a standalone one-off,
          // not "the Tuesday one moved" — detaching avoids colliding with
          // scheduled_posts_recurring_occurrence_key if the new time matches
          // another already-generated occurrence of the same series.
          recurring_schedule_id: null,
        },
        { count: "exact" },
      )
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", "pending")
      .select()
      .maybeSingle();
    if (error) {
      // 23505 = unique_violation. Only realistic cause here is the
      // recurring-occurrence unique constraint above.
      if (error.code === "23505") {
        res.status(409).json({ error: "This account already has a post scheduled for that exact time." });
        return;
      }
      dbError(res, error, "PATCH /scheduled-posts/:id/reschedule");
      return;
    }
    if (!count || !data) {
      res.status(409).json({ error: "Only a pending post can be rescheduled." });
      return;
    }
    // google_event_id is already set on this row (it was already synced
    // when first created), so this correctly PATCHes the existing Calendar
    // event's time rather than creating a second one.
    void syncPostToCalendar(data.id);
    void syncAccountSheet(req.accountId!);
    res.json(data);
  });

  // Pause/resume a single pending post without cancelling it — a
  // paused_at timestamp rather than a new status value (see migration
  // 0073's own comment for why): status stays 'pending' throughout, so
  // every other place that already gates on status='pending'
  // (releaseMediaIfOrphaned, DELETE /media/:id's in-use check, the
  // GET /scheduled-posts upcoming-list query) keeps working unchanged.
  // claimDuePosts() is the only place that needed to learn about this.
  router.patch("/scheduled-posts/:id/pause", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error, count } = await req.db!
      .from("scheduled_posts")
      .update({ paused_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", "pending")
      .is("paused_at", null)
      .select()
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /scheduled-posts/:id/pause");
      return;
    }
    if (!count || !data) {
      res.status(404).json({ error: "Not found, not owned by this caller, not pending, or already paused" });
      return;
    }
    // No calendar sync call — pausing doesn't change scheduled_for, and
    // eventMapper.ts doesn't mirror status/pause state onto the Calendar
    // event at all, so the mirrored event is already correct as-is.
    res.json(data);
  });

  router.patch("/scheduled-posts/:id/resume", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    // Resuming puts a paused post back into a platform's rolling-24h count
    // (platformPostLimits.ts -- paused posts aren't counted), so it needs
    // the same check a new post gets. A resumed post whose time already
    // passed goes out right away, so "now" is its effective time then.
    const { data: paused, error: pausedFetchError } = await req.db!
      .from("scheduled_posts")
      .select("id, scheduled_for, social_account_id, social_accounts(platform)")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", "pending")
      .not("paused_at", "is", null)
      .maybeSingle();
    if (pausedFetchError) {
      dbError(res, pausedFetchError, "PATCH /scheduled-posts/:id/resume lookup");
      return;
    }
    const pausedAccount = paused && (Array.isArray(paused.social_accounts) ? paused.social_accounts[0] : paused.social_accounts);
    if (paused && paused.social_account_id && paused.scheduled_for && pausedAccount?.platform) {
      const platformLimitError = await checkPlatformPostLimit({
        socialAccountId: paused.social_account_id,
        platform: pausedAccount.platform,
        scheduledFor: new Date(Math.max(new Date(paused.scheduled_for).getTime(), Date.now())),
        excludePostId: paused.id,
      });
      if (platformLimitError) {
        res.status(platformLimitError.status).json(platformLimitError.body);
        return;
      }
    }

    const { data, error, count } = await req.db!
      .from("scheduled_posts")
      .update({ paused_at: null }, { count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .eq("status", "pending")
      .not("paused_at", "is", null)
      .select()
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /scheduled-posts/:id/resume");
      return;
    }
    if (!count || !data) {
      res.status(404).json({ error: "Not found, not owned by this caller, not pending, or not paused" });
      return;
    }
    res.json(data);
  });

  // Copy an existing post to a new day — reuses scheduleOnePost wholesale
  // (validatePostFields + checkFreeTierPostLimit + insert + calendar sync),
  // the exact same path a brand-new post goes through, since a duplicate
  // really is a brand-new row that happens to be pre-filled from another
  // one. Deliberately does NOT carry forward google_event_id/
  // google_updated_at/last_synced_at (scheduleOnePost's insert never sets
  // them, so they're correctly null on the new row — copying google_event_id
  // would violate its unique partial index) or recurring_schedule_id (also
  // never set by scheduleOnePost) — a duplicate is always a standalone
  // one-off, matching the reschedule route's own detach behavior above.
  router.post("/scheduled-posts/:id/duplicate", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await req.db!
      .from("scheduled_posts")
      .select(
        "social_account_id, content, media_url, cover_image_url, board_id, destination_link, first_comment, media_alt_text, tiktok_privacy_level, tiktok_disable_comment, tiktok_disable_duet, tiktok_disable_stitch, tiktok_brand_organic, tiktok_brand_content, status",
      )
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "POST /scheduled-posts/:id/duplicate lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    if (existing.status === "draft" || existing.status === "posting") {
      res.status(400).json({ error: "Drafts and in-flight posts can't be duplicated this way" });
      return;
    }

    const result = await scheduleOnePost(req.accountId, {
      socialAccountId: existing.social_account_id,
      content: existing.content,
      mediaUrl: existing.media_url,
      coverImageUrl: existing.cover_image_url,
      boardId: existing.board_id,
      destinationLink: existing.destination_link,
      firstComment: existing.first_comment,
      mediaAltText: existing.media_alt_text,
      tiktokPrivacyLevel: existing.tiktok_privacy_level,
      tiktokDisableComment: existing.tiktok_disable_comment,
      tiktokDisableDuet: existing.tiktok_disable_duet,
      tiktokDisableStitch: existing.tiktok_disable_stitch,
      tiktokBrandOrganic: existing.tiktok_brand_organic,
      tiktokBrandContent: existing.tiktok_brand_content,
      scheduledFor: (req.body ?? {}).scheduledFor,
      requiresApproval: (req.body ?? {}).requiresApproval,
    });
    res.status(result.status).json(result.body);
  });

  // A pending post can be cancelled, or a posted/failed one cleared from
  // history — either way this is deleting the customer's own row. Only a
  // post mid-flight ("posting") is protected, since the scheduler is
  // actively working it at that moment.
  router.delete("/scheduled-posts/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await req.db!
      .from("scheduled_posts")
      .select("id, media_url, status")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "DELETE /scheduled-posts/:id lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    if (existing.status === "posting") {
      res.status(409).json({ error: "This post is being published right now — try again in a moment" });
      return;
    }

    // Awaited, not fire-and-forget like the other call sites — it needs to
    // read the row's google_event_id BEFORE the delete below removes it,
    // so it can't race the delete. deletePostFromCalendar never throws (see
    // its own internal try/catch) — a failed calendar cleanup still can't
    // block the delete itself, it just leaves a stale Calendar event behind
    // to clean up later rather than failing the customer's delete action.
    await deletePostFromCalendar(existing.id);

    // Stays on supabase, not req.db: scheduled_posts_delete_members (see
    // 0082_fix_account_members_policy_recursion.sql) only allows deleting a
    // row while status='pending', but this route also deletes posted/
    // failed/draft/needs_approval history (only 'posting' is blocked
    // above) -- under RLS that would silently delete 0 rows for every
    // status but pending and misreport as 404.
    const { error, count } = await supabase
      .from("scheduled_posts")
      .delete({ count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId);
    if (error) {
      dbError(res, error, "DELETE /scheduled-posts/:id");
      return;
    }
    if (count === 0) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    void syncAccountSheet(req.accountId!);

    // Deleting the post is what a customer actually means by "free up
    // storage" — reclaim the attached media too, but only once nothing else
    // (another pending/posting post) still points at the same file.
    if (existing.media_url) {
      await releaseMediaIfOrphaned(existing.media_url, req.accountId!);
    }
    res.status(204).send();
  });

  // Generates the public Proof-of-Publish share link for a post. A human
  // dashboard session (JWT) can always do this — the frontend shows a
  // confirm dialog before calling it, since each share is a deliberate
  // one-off decision. A customer API key can only do it if that specific
  // key has can_share_proof set (opted in at creation, off by default) —
  // a genuine bring-your-own-agent automation path, not a standing default
  // power. See migration 0038_proof_link_sharing.sql.
  router.get("/scheduled-posts/:id/proof-link", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    if (req.authMethod === "apiKey" && !req.isAdmin && !req.apiKeyCanShareProof) {
      res.status(403).json({
        error: "This API key isn't permitted to generate proof-sharing links. Enable it for this key in your dashboard's API Keys settings.",
      });
      return;
    }

    const { data: result, error } = await req.db!
      .from("post_results")
      .select("id, verified_live")
      .eq("scheduled_post_id", req.params.id)
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /scheduled-posts/:id/proof-link");
      return;
    }
    if (!result || !result.verified_live) {
      res.status(400).json({ error: "This post hasn't been verified live yet — nothing to share." });
      return;
    }
    res.json({ url: `${PUBLIC_SITE_URL}/verify/${result.id}` });
  });

  return router;
}
