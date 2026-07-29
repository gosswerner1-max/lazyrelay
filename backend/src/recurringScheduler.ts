import { DateTime } from "luxon";
import { supabase } from "./supabase.js";
import { resolveTier } from "./tier.js";

// How far ahead to keep scheduled_posts populated from active recurring
// schedules. Short enough that an outage under a week never silently loses
// an occurrence (it materializes as soon as this job runs again), long
// enough that the job doesn't need sub-hourly precision to stay caught up.
const GENERATION_WINDOW_DAYS = 7;

interface RecurringScheduleRow {
  id: string;
  account_id: string;
  content: string;
  media_url: string | null;
  days_of_week: number[];
  time_of_day: string; // "HH:mm:ss" from Postgres `time`
  timezone: string;
  starts_on: string;
  ends_on: string | null;
  recurring_schedule_targets: Array<{ social_account_id: string }>;
}

/** Pure function — every occurrence of `slot` that falls within
 *  [now, now + windowDays), in the slot's own timezone, respecting
 *  starts_on/ends_on. Kept separate from any I/O so the DST/boundary edge
 *  cases (the genuinely tricky part of this feature) can be unit-tested
 *  without a database. */
export function computeOccurrencesInWindow(
  slot: Pick<RecurringScheduleRow, "days_of_week" | "time_of_day" | "timezone" | "starts_on" | "ends_on">,
  windowDays: number,
  now: DateTime = DateTime.utc(),
): DateTime[] {
  const [hour, minute] = slot.time_of_day.split(":").map(Number);
  const zoneNow = now.setZone(slot.timezone);
  const startsOn = DateTime.fromISO(slot.starts_on, { zone: slot.timezone });
  const endsOn = slot.ends_on ? DateTime.fromISO(slot.ends_on, { zone: slot.timezone }).endOf("day") : null;
  const daysOfWeek = new Set(slot.days_of_week);

  const occurrences: DateTime[] = [];
  // Walk day-by-day rather than computing weekday math directly — trivially
  // correct across DST transitions since each day's wall-clock time is set
  // fresh via luxon's zone-aware `.set()`, not by adding a fixed duration
  // that could drift by an hour across a spring-forward/fall-back boundary.
  for (let i = 0; i < windowDays; i++) {
    const day = zoneNow.startOf("day").plus({ days: i });
    if (!daysOfWeek.has(day.weekday)) continue;

    const occurrence = day.set({ hour, minute, second: 0, millisecond: 0 });
    if (occurrence < startsOn) continue;
    if (endsOn && occurrence > endsOn) continue;
    if (occurrence < now) continue; // don't generate anything already in the past

    occurrences.push(occurrence);
  }
  return occurrences;
}

/** Materializes due occurrences from every active recurring schedule into
 *  real scheduled_posts rows. Deliberately a separate job from
 *  runSchedulerCycle() in scheduler.ts, which stays untouched and keeps
 *  draining whatever's sitting in scheduled_posts — this only ever writes
 *  INTO that queue, upstream of the existing drain/retry/breaker/
 *  Proof-of-Publish logic, so a generated occurrence is indistinguishable
 *  from a one-off post once it exists. */
export async function generateDuePosts(): Promise<void> {
  const { data: active, error } = await supabase
    .from("recurring_schedules")
    .select("*, recurring_schedule_targets(social_account_id)")
    .eq("status", "active");
  if (error) {
    console.error("[recurringScheduler] failed to load active schedules:", error.message);
    return;
  }
  if (!active || active.length === 0) return;

  for (const slot of active as unknown as RecurringScheduleRow[]) {
    const occurrences = computeOccurrencesInWindow(slot, GENERATION_WINDOW_DAYS);
    if (occurrences.length === 0) continue;

    // Free-tier gating doesn't apply here (recurring schedules are
    // paid-only, enforced at creation time in routes.ts), but a lapsed
    // payment mid-cycle should stop generating new posts the same way it
    // already stops the one-off free-tier count reset from mattering —
    // resolveTier() falls back to "free" for any non-active/-trialing
    // subscription, so this simply skips generation rather than posting
    // against a plan that no longer has this feature.
    const tier = await resolveTier(slot.account_id);
    if (tier === "free") continue;

    for (const occurrenceAt of occurrences) {
      for (const target of slot.recurring_schedule_targets) {
        // Skip a paused connected account (plan-downgrade case) up front —
        // avoids generating a post the existing scheduler would just fail
        // anyway, same check processPost() already does at drain-time.
        const { data: account } = await supabase
          .from("social_accounts")
          .select("paused_at")
          .eq("id", target.social_account_id)
          .maybeSingle();
        if (account?.paused_at) continue;

        const { error: insertError } = await supabase.from("scheduled_posts").upsert(
          {
            account_id: slot.account_id,
            social_account_id: target.social_account_id,
            content: slot.content,
            media_url: slot.media_url,
            scheduled_for: occurrenceAt.toUTC().toISO(),
            recurring_schedule_id: slot.id,
          },
          { onConflict: "recurring_schedule_id,social_account_id,scheduled_for", ignoreDuplicates: true },
        );
        if (insertError) {
          console.error(`[recurringScheduler] failed to generate occurrence for slot ${slot.id}:`, insertError.message);
        }
      }
    }
  }
}

/** Deletes future, not-yet-fired occurrences generated by a slot — shared by
 *  pause (stop future posting without losing history) and edit (the "no
 *  in-place update" decision: any edit cancels pending occurrences, the
 *  customer's save regenerates fresh ones under the new content on the next
 *  generateDuePosts() run). Already-fired occurrences (posted/failed/
 *  posting) are never touched — this is forward-only, it doesn't rewrite
 *  history. */
export async function cancelFuturePendingOccurrences(recurringScheduleId: string): Promise<void> {
  await supabase
    .from("scheduled_posts")
    .delete()
    .eq("recurring_schedule_id", recurringScheduleId)
    .eq("status", "pending")
    .gt("scheduled_for", new Date().toISOString());
}
