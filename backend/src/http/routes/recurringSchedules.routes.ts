// recurringSchedules routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.

import { Router } from "express";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { MAX_POST_CONTENT_LENGTH, MAX_BOARD_ID_LENGTH, MAX_DESTINATION_LINK_LENGTH, MAX_FIRST_COMMENT_LENGTH, TIKTOK_PRIVACY_LEVELS } from "../../postCreation.js";
import { resolveTier, RECURRING_SCHEDULE_SLOT_LIMITS } from "../../tier.js";
import { cancelFuturePendingOccurrences } from "../../recurringScheduler.js";
import { isSafeMediaUrl } from "../../urlSafety.js";
import { dbError } from "./shared.js";

export function buildRecurringSchedulesRouter(): Router {
  const router = Router();

  // --- Recurring schedules ("set it up once a week") ---
  // See docs/feature-spec-recurring-schedules.md for the full design.

  const DAYS_OF_WEEK_RANGE = { min: 1, max: 7 }; // ISO weekday, 1=Mon..7=Sun

  function isValidTimezone(tz: string): boolean {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  interface RecurringScheduleInput {
    content?: unknown;
    mediaUrl?: unknown;
    coverImageUrl?: unknown;
    boardId?: unknown;
    destinationLink?: unknown;
    firstComment?: unknown;
    tiktokPrivacyLevel?: unknown;
    tiktokDisableComment?: unknown;
    tiktokDisableDuet?: unknown;
    tiktokDisableStitch?: unknown;
    tiktokBrandOrganic?: unknown;
    tiktokBrandContent?: unknown;
    socialAccountIds?: unknown;
    daysOfWeek?: unknown;
    timeOfDay?: unknown;
    timezone?: unknown;
    startsOn?: unknown;
    endsOn?: unknown;
  }

  /** Shared validation for both create and edit — returns a customer-facing
   *  error string, or null if everything present is valid. Fields not
   *  present in `input` (relevant for PATCH, which may only be setting
   *  `status`) are skipped rather than required.
   *
   *  Async because mediaUrl/coverImageUrl need the same SSRF check as
   *  validatePostFields above — a recurring schedule's media_url is stored
   *  once here and then fetched server-side on every future occurrence
   *  without going through validatePostFields again, so an unsafe URL has
   *  to be caught at this write instead. */
  async function validateRecurringScheduleInput(input: RecurringScheduleInput, requireAll: boolean): Promise<string | null> {
    if (input.mediaUrl !== undefined && input.mediaUrl !== null) {
      if (typeof input.mediaUrl !== "string") return "mediaUrl must be a string";
      const result = await isSafeMediaUrl(input.mediaUrl);
      if (!result.safe) return `mediaUrl ${result.reason}`;
    }
    if (input.coverImageUrl !== undefined && input.coverImageUrl !== null && typeof input.coverImageUrl === "string") {
      const result = await isSafeMediaUrl(input.coverImageUrl);
      if (!result.safe) return `coverImageUrl ${result.reason}`;
    }
    if (requireAll || input.content !== undefined) {
      if (typeof input.content !== "string" || input.content.trim().length === 0) {
        return "content must be a non-empty string";
      }
      if (input.content.length > MAX_POST_CONTENT_LENGTH) {
        return `content must be ${MAX_POST_CONTENT_LENGTH} characters or fewer`;
      }
    }
    if (requireAll || input.socialAccountIds !== undefined) {
      if (!Array.isArray(input.socialAccountIds) || input.socialAccountIds.length === 0) {
        return "socialAccountIds must be a non-empty array";
      }
      if (!input.socialAccountIds.every((id) => typeof id === "string")) {
        return "socialAccountIds must all be strings";
      }
    }
    if (requireAll || input.daysOfWeek !== undefined) {
      if (
        !Array.isArray(input.daysOfWeek) ||
        input.daysOfWeek.length === 0 ||
        input.daysOfWeek.length > 7 ||
        !input.daysOfWeek.every(
          (d) => typeof d === "number" && Number.isInteger(d) && d >= DAYS_OF_WEEK_RANGE.min && d <= DAYS_OF_WEEK_RANGE.max,
        )
      ) {
        return "daysOfWeek must be 1-7 integers (1=Monday..7=Sunday)";
      }
    }
    if (requireAll || input.timeOfDay !== undefined) {
      if (typeof input.timeOfDay !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(input.timeOfDay)) {
        return "timeOfDay must be in HH:mm format (24-hour)";
      }
    }
    if (requireAll || input.timezone !== undefined) {
      if (typeof input.timezone !== "string" || !isValidTimezone(input.timezone)) {
        return "timezone must be a valid IANA timezone name (e.g. \"Africa/Johannesburg\")";
      }
    }
    if (input.startsOn !== undefined && input.startsOn !== null) {
      if (typeof input.startsOn !== "string" || Number.isNaN(new Date(input.startsOn).getTime())) {
        return "startsOn must be a valid date string";
      }
    }
    if (input.endsOn !== undefined && input.endsOn !== null) {
      if (typeof input.endsOn !== "string" || Number.isNaN(new Date(input.endsOn).getTime())) {
        return "endsOn must be a valid date string";
      }
    }
    if (input.coverImageUrl !== undefined && input.coverImageUrl !== null && typeof input.coverImageUrl !== "string") {
      return "coverImageUrl must be a string";
    }
    if (input.boardId !== undefined && input.boardId !== null && typeof input.boardId !== "string") {
      return "boardId must be a string";
    }
    if (typeof input.boardId === "string" && input.boardId.length > MAX_BOARD_ID_LENGTH) {
      return `boardId must be ${MAX_BOARD_ID_LENGTH} characters or fewer`;
    }
    if (input.destinationLink !== undefined && input.destinationLink !== null && typeof input.destinationLink !== "string") {
      return "destinationLink must be a string";
    }
    if (typeof input.destinationLink === "string" && input.destinationLink.length > MAX_DESTINATION_LINK_LENGTH) {
      return `destinationLink must be ${MAX_DESTINATION_LINK_LENGTH} characters or fewer`;
    }
    if (input.firstComment !== undefined && input.firstComment !== null && typeof input.firstComment !== "string") {
      return "firstComment must be a string";
    }
    if (typeof input.firstComment === "string" && input.firstComment.length > MAX_FIRST_COMMENT_LENGTH) {
      return `firstComment must be ${MAX_FIRST_COMMENT_LENGTH} characters or fewer`;
    }
    if (input.tiktokPrivacyLevel !== undefined && input.tiktokPrivacyLevel !== null) {
      if (typeof input.tiktokPrivacyLevel !== "string" || !TIKTOK_PRIVACY_LEVELS.includes(input.tiktokPrivacyLevel)) {
        return `tiktokPrivacyLevel must be one of: ${TIKTOK_PRIVACY_LEVELS.join(", ")}`;
      }
    }
    for (const [name, value] of [
      ["tiktokDisableComment", input.tiktokDisableComment],
      ["tiktokDisableDuet", input.tiktokDisableDuet],
      ["tiktokDisableStitch", input.tiktokDisableStitch],
      ["tiktokBrandOrganic", input.tiktokBrandOrganic],
      ["tiktokBrandContent", input.tiktokBrandContent],
    ] as const) {
      if (value !== undefined && typeof value !== "boolean") {
        return `${name} must be a boolean`;
      }
    }
    if (input.tiktokBrandContent === true && input.tiktokPrivacyLevel === "SELF_ONLY") {
      return "Branded content on TikTok can't be set to private — choose a different privacy level";
    }
    return null;
  }

  router.post("/recurring-schedules", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const input = (req.body ?? {}) as RecurringScheduleInput;
    const validationError = await validateRecurringScheduleInput(input, true);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const tier = await resolveTier(req.accountId!);
    const limit = RECURRING_SCHEDULE_SLOT_LIMITS[tier];
    if (limit === 0) {
      res.status(403).json({
        error: "Recurring schedules are a paid-tier feature. Upgrade to Starter, Pro, or Business to set up recurring posts.",
      });
      return;
    }
    if (limit !== null) {
      // Any status counts against the cap — a paused slot still occupies a
      // content cadence, it hasn't been deleted.
      const { count, error: countError } = await req.db!
        .from("recurring_schedules")
        .select("id", { count: "exact", head: true })
        .eq("account_id", req.accountId);
      if (countError) {
        dbError(res, countError, "POST /recurring-schedules slot count");
        return;
      }
      if ((count ?? 0) >= limit) {
        res.status(403).json({
          error: `Your plan allows up to ${limit} recurring schedules. Delete one, or upgrade for more.`,
        });
        return;
      }
    }

    // Confirm every target social account actually belongs to this caller —
    // same ownership check POST /scheduled-posts already does for a single
    // account, applied per-target here.
    const socialAccountIds = input.socialAccountIds as string[];
    const { data: owned, error: ownedError } = await req.db!
      .from("social_accounts")
      .select("id")
      .eq("account_id", req.accountId)
      .in("id", socialAccountIds);
    if (ownedError) {
      dbError(res, ownedError, "POST /recurring-schedules ownership check");
      return;
    }
    if ((owned ?? []).length !== socialAccountIds.length) {
      res.status(403).json({ error: "One or more social accounts weren't found or aren't owned by this caller" });
      return;
    }

    const { data: slot, error } = await req.db!
      .from("recurring_schedules")
      .insert({
        account_id: req.accountId,
        content: input.content,
        media_url: input.mediaUrl ?? null,
        cover_image_url: input.coverImageUrl ?? null,
        board_id: input.boardId ?? null,
        destination_link: input.destinationLink ?? null,
        first_comment: input.firstComment ?? null,
        tiktok_privacy_level: (input.tiktokPrivacyLevel as string | undefined) ?? null,
        tiktok_disable_comment: (input.tiktokDisableComment as boolean | undefined) ?? true,
        tiktok_disable_duet: (input.tiktokDisableDuet as boolean | undefined) ?? true,
        tiktok_disable_stitch: (input.tiktokDisableStitch as boolean | undefined) ?? true,
        tiktok_brand_organic: (input.tiktokBrandOrganic as boolean | undefined) ?? false,
        tiktok_brand_content: (input.tiktokBrandContent as boolean | undefined) ?? false,
        days_of_week: input.daysOfWeek,
        time_of_day: `${input.timeOfDay}:00`,
        timezone: input.timezone,
        starts_on: input.startsOn ?? undefined,
        ends_on: input.endsOn ?? null,
      })
      .select()
      .single();
    if (error || !slot) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /recurring-schedules insert");
      return;
    }

    const { error: targetsError } = await req.db!
      .from("recurring_schedule_targets")
      .insert(socialAccountIds.map((social_account_id) => ({ recurring_schedule_id: slot.id, social_account_id })));
    if (targetsError) {
      // Roll back the slot rather than leaving an orphaned schedule with no
      // targets — a slot with zero targets would never generate anything
      // and would silently occupy the customer's tier cap for nothing.
      await req.db!.from("recurring_schedules").delete().eq("id", slot.id);
      dbError(res, targetsError, "POST /recurring-schedules targets insert");
      return;
    }

    res.status(201).json({ ...slot, social_account_ids: socialAccountIds });
  });

  router.get("/recurring-schedules", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await req.db!
      .from("recurring_schedules")
      .select("*, recurring_schedule_targets(social_account_id)")
      .eq("account_id", req.accountId)
      .order("created_at", { ascending: false });
    if (error) {
      dbError(res, error, "GET /recurring-schedules");
      return;
    }
    res.json(
      (data ?? []).map((slot) => ({
        ...slot,
        social_account_ids: slot.recurring_schedule_targets.map((t: { social_account_id: string }) => t.social_account_id),
        recurring_schedule_targets: undefined,
      })),
    );
  });

  router.patch("/recurring-schedules/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await req.db!
      .from("recurring_schedules")
      .select("id, status")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "PATCH /recurring-schedules/:id lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }

    const input = (req.body ?? {}) as RecurringScheduleInput & { status?: unknown };
    if (input.status !== undefined && input.status !== "active" && input.status !== "paused") {
      res.status(400).json({ error: "status must be \"active\" or \"paused\"" });
      return;
    }
    const validationError = await validateRecurringScheduleInput(input, false);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    // Resuming (paused -> active, nothing else changing) never needs to
    // cancel anything — there's nothing stale to invalidate. Every other
    // change — pausing, or editing any content/schedule field while
    // active — cancels future not-yet-fired generated occurrences per the
    // "no in-place update" decision: the customer's save regenerates fresh
    // ones under the new configuration on the next generation cycle.
    const isPureResume = input.status === "active" && existing.status === "paused" &&
      input.content === undefined && input.mediaUrl === undefined && input.coverImageUrl === undefined &&
      input.boardId === undefined && input.destinationLink === undefined && input.firstComment === undefined &&
      input.socialAccountIds === undefined &&
      input.daysOfWeek === undefined && input.timeOfDay === undefined && input.timezone === undefined &&
      input.startsOn === undefined && input.endsOn === undefined;
    if (!isPureResume) {
      await cancelFuturePendingOccurrences(req.params.id as string);
    }

    if (input.socialAccountIds !== undefined) {
      const socialAccountIds = input.socialAccountIds as string[];
      const { data: owned, error: ownedError } = await req.db!
        .from("social_accounts")
        .select("id")
        .eq("account_id", req.accountId)
        .in("id", socialAccountIds);
      if (ownedError) {
        dbError(res, ownedError, "PATCH /recurring-schedules/:id ownership check");
        return;
      }
      if ((owned ?? []).length !== socialAccountIds.length) {
        res.status(403).json({ error: "One or more social accounts weren't found or aren't owned by this caller" });
        return;
      }
      await req.db!.from("recurring_schedule_targets").delete().eq("recurring_schedule_id", req.params.id);
      const { error: targetsError } = await req.db!
        .from("recurring_schedule_targets")
        .insert(socialAccountIds.map((social_account_id) => ({ recurring_schedule_id: req.params.id, social_account_id })));
      if (targetsError) {
        dbError(res, targetsError, "PATCH /recurring-schedules/:id targets update");
        return;
      }
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.content !== undefined) updates.content = input.content;
    if (input.mediaUrl !== undefined) updates.media_url = input.mediaUrl;
    if (input.coverImageUrl !== undefined) updates.cover_image_url = input.coverImageUrl;
    if (input.boardId !== undefined) updates.board_id = input.boardId;
    if (input.destinationLink !== undefined) updates.destination_link = input.destinationLink;
    if (input.firstComment !== undefined) updates.first_comment = input.firstComment;
    if (input.tiktokPrivacyLevel !== undefined) updates.tiktok_privacy_level = input.tiktokPrivacyLevel;
    if (input.tiktokDisableComment !== undefined) updates.tiktok_disable_comment = input.tiktokDisableComment;
    if (input.tiktokDisableDuet !== undefined) updates.tiktok_disable_duet = input.tiktokDisableDuet;
    if (input.tiktokDisableStitch !== undefined) updates.tiktok_disable_stitch = input.tiktokDisableStitch;
    if (input.tiktokBrandOrganic !== undefined) updates.tiktok_brand_organic = input.tiktokBrandOrganic;
    if (input.tiktokBrandContent !== undefined) updates.tiktok_brand_content = input.tiktokBrandContent;
    if (input.daysOfWeek !== undefined) updates.days_of_week = input.daysOfWeek;
    if (input.timeOfDay !== undefined) updates.time_of_day = `${input.timeOfDay}:00`;
    if (input.timezone !== undefined) updates.timezone = input.timezone;
    if (input.startsOn !== undefined) updates.starts_on = input.startsOn;
    if (input.endsOn !== undefined) updates.ends_on = input.endsOn;
    if (input.status !== undefined) updates.status = input.status;

    // Ownership was already verified above (existing, fetched with
    // .eq("account_id", req.accountId)) — this update deliberately doesn't
    // repeat that filter, since it's the same synchronous request with no
    // TOCTOU window. If this line ever moves earlier, or the fetch above
    // is removed/reordered, add .eq("account_id", req.accountId) back here
    // too — found worth flagging by the 2026-08-26 IDOR audit.
    const { data: updated, error } = await req.db!
      .from("recurring_schedules")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error || !updated) {
      dbError(res, error ?? { message: "update returned no row" }, "PATCH /recurring-schedules/:id");
      return;
    }
    res.json(updated);
  });

  // ?cancelUpcoming=true also cancels not-yet-fired generated occurrences;
  // without it, already-generated pending posts are detached (their
  // recurring_schedule_id set null via the FK's `on delete set null`) and
  // left to fire normally — history is never touched either way.
  router.delete("/recurring-schedules/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: existing, error: fetchError } = await req.db!
      .from("recurring_schedules")
      .select("id")
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .maybeSingle();
    if (fetchError) {
      dbError(res, fetchError, "DELETE /recurring-schedules/:id lookup");
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }

    if (req.query.cancelUpcoming === "true") {
      await cancelFuturePendingOccurrences(req.params.id as string);
    }

    // Same reasoning as the PATCH handler above: ownership was already
    // verified via `existing` (fetched with .eq("account_id", req.accountId)),
    // so this delete doesn't repeat the filter — same synchronous request,
    // no TOCTOU window. Keep the account_id filter here if this line ever
    // moves earlier or the fetch above changes. Flagged by the 2026-08-26
    // IDOR audit.
    const { error } = await req.db!.from("recurring_schedules").delete().eq("id", req.params.id);
    if (error) {
      dbError(res, error, "DELETE /recurring-schedules/:id");
      return;
    }
    res.status(204).send();
  });

  return router;
}
