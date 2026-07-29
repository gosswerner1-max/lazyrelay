# Feature Spec: Recurring Schedules (weekly setup + pause/resume)

Status: **Proposed, not built.** Grounded in the current codebase as of 2026-07-29 (`backend/src/scheduler.ts`, `backend/src/http/routes.ts`, `backend/supabase/migrations/0001_init_schema.sql`, `frontend/src/pages/Dashboard.tsx`).

## Problem

Today, `scheduled_posts` is a flat queue: one form submission = one row = one send time for one account (`POST /scheduled-posts` in `routes.ts:370`). A customer running ongoing social ops has to manually resubmit the form for every future occurrence — there's no way to say "post this every Monday/Wednesday/Friday at 9am across these 3 platforms" once and have it keep happening. There's also no pause: a pending post can only be cancelled outright (deleted), never temporarily suspended and resumed later.

Confirmed via direct research (2026-07-29) that Blotato has recurring time-slots ("set up recurring time slots, assign platforms to each slot, and Blotato queues everything automatically") but **no pause/resume feature at all** — bulk-select-and-delete is their only bulk control. So the "set up once a week" half is table stakes to build; the pause/resume half is a genuine, unclaimed differentiator, not a gap we're behind on.

## Goals

1. A customer can define a recurring content slot once (content + platforms + days-of-week + time) and have it generate real posts indefinitely without re-submitting the form.
2. A customer can pause a recurring slot — future occurrences stop generating — without losing the slot's configuration or its history.
3. A customer can resume a paused slot and it picks back up on the next occurrence (never "catches up" on missed ones — see Open Question 1).
4. None of this touches the existing one-off "Schedule a post" flow, which stays exactly as-is for a single specific post.

## Non-goals (v1)

- Per-slot content *variation* (rotating between multiple caption variants) — v1 posts identical content every occurrence, matching Blotato's stated model.
- Editing an individual generated occurrence's time/content independently of the parent slot (that's already possible today via the existing per-post Cancel/Delete once it's materialized as a real `scheduled_posts` row — this spec doesn't need to duplicate that).
- Cross-timezone scheduling per slot beyond a single stored IANA timezone (see schema below) — no "post at 9am in each viewer's local time."

## Data model

New table, additive migration (`000X_recurring_schedules.sql`), no changes to `scheduled_posts` or `post_results`:

```sql
create table recurring_schedules (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  content text not null,
  media_url text,
  -- Bitmask-free, explicit array of ISO weekday ints (1=Mon..7=Sun) — matches
  -- how the frontend's day-picker UI will naturally emit a value, and reads
  -- clearly in SQL/JSON without needing a bitmask decode step anywhere.
  days_of_week smallint[] not null check (array_length(days_of_week, 1) between 1 and 7),
  -- Local wall-clock time + an explicit IANA zone name, NOT a UTC-normalized
  -- time — a slot set for "9am" must keep firing at 9am through DST
  -- transitions, which a pre-baked UTC offset would silently break twice a year.
  time_of_day time not null,
  timezone text not null default 'UTC',
  status text not null default 'active' check (status in ('active', 'paused')),
  starts_on date not null default current_date,
  ends_on date, -- null = runs indefinitely
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A slot can target multiple accounts (multi-platform "set up once for all
-- platforms" is the entire point) — junction table, not an array column, so
-- RLS/cascade behavior on social_accounts deletion is a normal FK, not
-- application-level cleanup of an array.
create table recurring_schedule_targets (
  recurring_schedule_id uuid not null references recurring_schedules(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  primary key (recurring_schedule_id, social_account_id)
);

-- Traces which generated scheduled_posts row came from which slot occurrence,
-- so pausing/resuming/deleting a slot can find and act on its own generated
-- posts without a fragile content/time-based guess.
alter table scheduled_posts add column recurring_schedule_id uuid references recurring_schedules(id) on delete set null;

alter table recurring_schedules enable row level security;
create policy "recurring_schedules_all_own" on recurring_schedules
  for all using (auth.uid() = account_id) with check (auth.uid() = account_id);

alter table recurring_schedule_targets enable row level security;
create policy "recurring_schedule_targets_all_own" on recurring_schedule_targets
  for all using (
    exists (select 1 from recurring_schedules rs where rs.id = recurring_schedule_id and rs.account_id = auth.uid())
  );
```

`recurring_schedule_id` on `scheduled_posts` is nullable and `on delete set null` — deleting the parent slot never cascades into deleting or orphaning already-generated/already-posted rows; those keep existing as ordinary one-off posts in history, exactly like today.

## Generation engine

A new, small, separate job — **not** a change to `runSchedulerCycle()` in `scheduler.ts`, which stays exactly as-is and keeps draining whatever's sitting in `scheduled_posts`. This is a materializer that writes INTO `scheduled_posts`, upstream of the existing drain logic:

```ts
// backend/src/recurringScheduler.ts (new file)
const GENERATION_WINDOW_DAYS = 7; // how far ahead to keep scheduled_posts populated

export async function generateDuePosts(): Promise<void> {
  const { data: active } = await supabase
    .from("recurring_schedules")
    .select("*, recurring_schedule_targets(social_account_id)")
    .eq("status", "active");

  for (const slot of active ?? []) {
    const occurrences = computeOccurrencesInWindow(slot, GENERATION_WINDOW_DAYS); // pure function, easy to unit test
    for (const occurrenceAt of occurrences) {
      for (const target of slot.recurring_schedule_targets) {
        // Idempotency: a unique index prevents double-generation if this
        // job runs more than once inside the same window (same failure
        // mode class already solved for scheduler.ts's claimDuePosts()).
        await supabase.from("scheduled_posts").upsert(
          {
            account_id: slot.account_id,
            social_account_id: target.social_account_id,
            content: slot.content,
            media_url: slot.media_url,
            scheduled_for: occurrenceAt.toISOString(),
            recurring_schedule_id: slot.id,
          },
          { onConflict: "recurring_schedule_id,social_account_id,scheduled_for", ignoreDuplicates: true }
        );
      }
    }
  }
}
```

Needs one more migration: a unique constraint `unique (recurring_schedule_id, social_account_id, scheduled_for)` on `scheduled_posts` (nullable columns are fine in a Postgres unique index — NULLs just never conflict with each other, which correctly leaves one-off posts unaffected).

Run on the same interval cadence as `runSchedulerCycle()` (check `index.ts` for the existing poll loop/cron trigger and add this as a sibling call, not a replacement). A 7-day rolling window means: even if the app is down for under a week, no occurrences are silently lost — they generate as soon as the job runs again. Longer outages are an explicit known gap (see Open Question 1).

## Pause / resume semantics

- **Pause** (`PATCH /recurring-schedules/:id { status: "paused" }`): sets `status = 'paused'`, then deletes any rows in `scheduled_posts` where `recurring_schedule_id = :id and status = 'pending' and scheduled_for > now()`. Already-fired occurrences (`posted`/`failed`/`posting`) are never touched — pausing is forward-only, it doesn't rewrite history.
- **Resume** (`PATCH /recurring-schedules/:id { status: "active" }`): sets `status = 'active'`. The next `generateDuePosts()` run naturally repopulates the window from "now" forward — no special resume logic needed beyond flipping the status, since generation is idempotent and window-based rather than tracking a cursor.
- **Delete**: cascades via FK to `recurring_schedule_targets`; sets `recurring_schedule_id = null` on any already-generated `scheduled_posts` rows rather than deleting them (so pending-but-now-orphaned occurrences still fire once, and history is preserved) — UNLESS the caller explicitly also wants those cancelled, which is a second confirm step in the UI ("Delete schedule" vs "Delete schedule and cancel N upcoming posts").

## API surface (additive to `routes.ts`)

- `POST /recurring-schedules` — create. Body: `{ content, mediaUrl?, socialAccountIds: string[], daysOfWeek: number[], timeOfDay: "HH:mm", timezone, startsOn?, endsOn? }`. Same validation pattern already used in `POST /scheduled-posts` (content length cap, media pre-flight validation per platform via `mediaLimits.ts`, free-tier gating) applies per-target-account.
- `GET /recurring-schedules` — list, with `recurring_schedule_targets` and a computed `nextOccurrence` per slot for display.
- `PATCH /recurring-schedules/:id` — update fields OR flip `status` (pause/resume uses this same endpoint with just `{ status }` in the body, not a separate route, since it's the same ownership/validation path).
- `DELETE /recurring-schedules/:id` — per the semantics above, with a `?cancelUpcoming=true` query param for the "and cancel N upcoming posts" variant.

## Frontend (`Dashboard.tsx`)

New section alongside the existing "Schedule a post" form (not replacing it — one-off scheduling stays):

- "Recurring schedules" list, each row showing: content preview, platform icons (reusing `PlatformIcon`), days/time in the account's local timezone, status pill (Active/Paused), next occurrence, and a single toggle button — **Pause** when active, **Resume** when paused — plus Edit and Delete.
- "New recurring schedule" form: content + media (reuses existing compose UI), day-of-week picker (7 toggle chips, Mon–Sun), time picker, multi-select checkboxes for connected accounts (reuses the same multi-select pattern already planned for the platform-picker/multi-post work in `warm-sleeping-puffin.md`), optional end date.
- `api.ts` additions: `createRecurringSchedule`, `listRecurringSchedules`, `updateRecurringSchedule` (covers both edits and pause/resume), `deleteRecurringSchedule`.

## Interactions with existing systems

- **Free-tier post cap**: `generateDuePosts()` must run the same monthly-count check `POST /scheduled-posts` does today (`routes.ts:453-481`) before materializing an occurrence — otherwise a free-tier customer's recurring slot could silently blow past the 10-posts/account/month cap. If the cap is hit mid-window, skip that occurrence and surface it in the schedule list ("skipped — free tier limit reached") rather than silently dropping it or erroring the whole job.
- **Paused connected account** (`social_accounts.paused_at`, plan-downgrade case already handled in `scheduler.ts:144`): `generateDuePosts()` should skip targets whose account is paused, same as the existing scheduler already does at drain-time — avoids generating posts that `processPost()` will just fail anyway.
- **Media validation**: reuse `validateMediaForPlatform()` per target platform at slot-creation time (like the one-off form does), not per-occurrence-generation — no need to re-validate the same media file every week.
- **Proof-of-Publish / retry / circuit breaker**: completely untouched. Once a recurring slot materializes a row in `scheduled_posts`, it's indistinguishable from a one-off post to `runSchedulerCycle()` — same retry backoff, same breaker, same verification. This is the core reason to build recurrence as a generator-into-the-existing-queue rather than a parallel posting path.

## Decisions (confirmed 2026-07-29)

1. **Missed-occurrence handling on resume after a long pause/outage: skip, never catch up.** Resuming a slot only ever schedules occurrences from "now" forward — no backlog of stale posts gets dumped on resume.
2. **Editing a slot's content: no in-place update.** Editing any field of an active recurring schedule cancels that slot's currently-generated-but-not-yet-fired `scheduled_posts` rows (same delete as the pause path) rather than rewriting them — the customer re-saves the slot and it regenerates fresh occurrences under the new content on the next `generateDuePosts()` run. Simpler mental model than partial in-place updates, and reuses the exact same "cancel future pending occurrences" code path as pause, so there's no second code path to maintain.
3. **Tier gating: Free = 0 slots, Starter = 3, Pro = 5, Business = unlimited.** A real per-tier quantity cap, not a flat paid/free toggle. Reasoning: this maps to something the customer intuitively values — number of distinct *weekly content cadences* they're running (e.g. "Monday tips," "Wednesday behind-the-scenes," "Friday promo"), not a resource/abuse cap — and gives a clean, marketable upgrade ladder (Starter→Pro buys 2 more content cadences, Pro→Business removes the ceiling entirely). Since a single slot can already target multiple connected platforms at once (`recurring_schedule_targets`), the cap is on distinct cadences, not on posting volume or platform count — worth stating explicitly in the UI/pricing copy so 3 slots on Starter doesn't read as more restrictive than it is (it's 3 cadences × however many platforms are connected, not 3 posts/week total).

   **Cap values live in `tier.ts`**, next to `TIER_DISPLAY_NAMES`, as a single source of truth both the API and frontend read from:
   ```ts
   export const RECURRING_SCHEDULE_SLOT_LIMITS: Record<Tier, number | null> = {
     free: 0,
     pro: 3,        // displays as "Starter"
     business: 5,   // displays as "Pro"
     enterprise: null, // displays as "Business" — null = unlimited
   };
   ```
   `POST /recurring-schedules` counts the caller's existing rows in `recurring_schedules` (any status — a paused slot still occupies a cadence slot, it hasn't been deleted) before inserting, same pattern as the existing free-tier post-count check at `routes.ts:453-481`: resolve tier via `resolveTier()`, look up the limit, `403` with an upgrade-prompt message if `count >= limit` (skip the check entirely when `limit === null`). Note the DB-code/display-name mismatch again here — `RECURRING_SCHEDULE_SLOT_LIMITS` is keyed by DB code (`pro`/`business`/`enterprise`), which is why the inline comments above matter; don't let the DB key values be misread as literally meaning "Pro tier" when writing this table.

## Implementation notes from the decisions above

- `POST /recurring-schedules` and `PATCH /recurring-schedules/:id` both need a tier check up front: `sub?.tier !== "free" && (sub?.status === "active" || sub?.status === "trialing")`, the exact same predicate `POST /scheduled-posts` already computes at `routes.ts:462` for the free-tier post cap — reuse it, don't reimplement. A free-tier or lapsed-payment caller gets `403` with a clear upgrade-prompt message, same pattern as the existing free-tier-limit error at `routes.ts:476`.
- `PATCH /recurring-schedules/:id` becomes the single endpoint for pause, resume, AND content/schedule edits — all three funnel through the same "delete future pending generated rows tied to this slot_id" step before applying the update, since edit and pause now share identical downstream behavior (only resume skips that step, since resuming doesn't change anything to invalidate, and if there's an `active` window already generated for a schedule that was paused those rows would already have been deleted on Pause).

## Rough build sequence

1. Migration (`recurring_schedules`, `recurring_schedule_targets`, `scheduled_posts.recurring_schedule_id`, unique index).
2. `recurringScheduler.ts` generation job + unit tests for `computeOccurrencesInWindow()` (the one genuinely tricky piece — DST edges, `ends_on` boundary, leap years).
3. API routes + `api.ts` client methods.
4. Frontend: recurring-schedules list + create/edit form + pause/resume/delete controls.
5. Wire the generation job into whatever runs `runSchedulerCycle()` today (check `index.ts`).
6. Manual e2e: create a slot, confirm it materializes into `scheduled_posts` within one generation cycle, confirm a real post fires and verifies via the existing Proof-of-Publish path, pause mid-week and confirm future-but-not-past occurrences disappear, resume and confirm it picks back up.
