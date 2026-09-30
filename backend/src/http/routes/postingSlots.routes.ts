// Posting slots and "next free slot" (master list #13). The next-slot endpoint
// only suggests a time; the post is scheduled through the normal routes.

import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { dbError } from "./shared.js";
import { validateBody } from "../validation.js";
import { isValidTimeOfDay, nextFreeSlot, type PostingSlot } from "../../postingSlots.js";

export const MAX_POSTING_SLOTS = 20;

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const createSchema = z.object({
  daysOfWeek: z
    .array(z.number().int().min(1).max(7), { error: "daysOfWeek must be a list of weekday numbers, 1 (Mon) to 7 (Sun)" })
    .min(1, "Pick at least one day")
    .max(7),
  timeOfDay: z.string({ error: "timeOfDay is required" }).refine(isValidTimeOfDay, "timeOfDay must look like 09:00 (24 hour)"),
  timezone: z.string({ error: "timezone is required" }).refine(validZone, 'timezone must be a valid name like "Africa/Johannesburg"'),
});

interface SlotRow {
  id: string;
  days_of_week: number[];
  time_of_day: string;
  timezone: string;
}
const toPublic = (r: SlotRow) => ({ id: r.id, daysOfWeek: r.days_of_week, timeOfDay: r.time_of_day, timezone: r.timezone });
const guard = [requireAuth, tieredRateLimit] as const;

export function buildPostingSlotsRouter(): Router {
  const router = Router();

  router.get("/posting-slots", ...guard, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase.from("posting_slots").select("id, days_of_week, time_of_day, timezone").eq("account_id", req.accountId).order("created_at", { ascending: true });
    if (error) {
      dbError(res, error, "GET /posting-slots");
      return;
    }
    res.json({ maxSlots: MAX_POSTING_SLOTS, slots: ((data ?? []) as SlotRow[]).map(toPublic) });
  });

  router.post("/posting-slots", ...guard, async (req: AuthedRequest, res) => {
    const body = validateBody(createSchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { count } = await supabase.from("posting_slots").select("id", { count: "exact", head: true }).eq("account_id", req.accountId);
    if ((count ?? 0) >= MAX_POSTING_SLOTS) {
      res.status(400).json({ error: `You can save up to ${MAX_POSTING_SLOTS} posting times. Remove one first.` });
      return;
    }
    const { data, error } = await supabase
      .from("posting_slots")
      .insert({ account_id: req.accountId, days_of_week: [...new Set(body.data.daysOfWeek)].sort(), time_of_day: body.data.timeOfDay, timezone: body.data.timezone })
      .select("id, days_of_week, time_of_day, timezone")
      .single();
    if (error || !data) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /posting-slots");
      return;
    }
    res.status(201).json(toPublic(data as SlotRow));
  });

  router.delete("/posting-slots/:id", ...guard, async (req: AuthedRequest, res) => {
    const { data, error } = await supabase.from("posting_slots").delete().eq("id", req.params.id).eq("account_id", req.accountId).select("id");
    if (error) {
      dbError(res, error, "DELETE /posting-slots/:id");
      return;
    }
    if (!data || data.length === 0) {
      res.status(404).json({ error: "Posting time not found" });
      return;
    }
    res.json({ deleted: true });
  });

  // GET /posting-slots/next?socialAccountId=... : the first future slot no post on
  // that channel already uses.
  router.get("/posting-slots/next", ...guard, async (req: AuthedRequest, res) => {
    const socialAccountId = typeof req.query.socialAccountId === "string" ? req.query.socialAccountId : "";
    if (!socialAccountId) {
      res.status(400).json({ error: "socialAccountId is required" });
      return;
    }
    const { data: owned } = await supabase.from("social_accounts").select("id").eq("id", socialAccountId).eq("account_id", req.accountId).maybeSingle();
    if (!owned) {
      res.status(404).json({ error: "Connected account not found" });
      return;
    }
    const { data: slotRows, error } = await supabase.from("posting_slots").select("id, days_of_week, time_of_day, timezone").eq("account_id", req.accountId);
    if (error) {
      dbError(res, error, "GET /posting-slots/next (slots)");
      return;
    }
    const slots: PostingSlot[] = ((slotRows ?? []) as SlotRow[]).map((r) => ({ daysOfWeek: r.days_of_week, timeOfDay: r.time_of_day, timezone: r.timezone }));
    if (slots.length === 0) {
      res.status(404).json({ error: "No posting times saved yet. Add some in Settings, then try again." });
      return;
    }
    const now = new Date();
    const { data: taken, error: takenError } = await supabase
      .from("scheduled_posts")
      .select("scheduled_for")
      .eq("account_id", req.accountId)
      .eq("social_account_id", socialAccountId)
      .in("status", ["pending", "posting"])
      .gt("scheduled_for", now.toISOString());
    if (takenError) {
      dbError(res, takenError, "GET /posting-slots/next (taken)");
      return;
    }
    const next = nextFreeSlot(slots, ((taken ?? []) as Array<{ scheduled_for: string }>).map((t) => new Date(t.scheduled_for)), now);
    if (!next) {
      res.status(404).json({ error: "Every posting time in the next 60 days is already taken." });
      return;
    }
    res.json({ scheduledFor: next.toISOString() });
  });

  return router;
}
