-- Real bug found 2026-08-21 while live-testing a batching fix to
-- generateDuePosts() (recurringScheduler.ts) during a scaling review --
-- not hypothetical, confirmed with the actual production error:
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification".
--
-- Migration 0025 created scheduled_posts_recurring_occurrence_idx as a
-- PARTIAL unique index (`where recurring_schedule_id is not null`).
-- Postgres can only infer a partial index for a bare
-- `ON CONFLICT (columns)` clause if the same predicate is *also* supplied
-- in the ON CONFLICT clause itself -- something the Supabase JS client's
-- `.upsert(rows, { onConflict: "col1,col2,col3" })` has no way to pass.
-- Every recurring-post upsert -- the entire idempotency mechanism the
-- recurring-schedules feature depends on -- has been silently failing
-- since the feature shipped (confirmed live: the exact single-row upsert
-- shape the original code used also reproduces this error). Zero
-- customers were affected only because recurring_schedules is currently
-- empty, not because this ever worked.
--
-- Fix: a real (non-partial) unique CONSTRAINT on the same three columns.
-- The partial WHERE clause was never actually load-bearing for
-- correctness -- Postgres unique constraints already treat NULL as never
-- equal to another NULL by default, so one-off posts (recurring_schedule_id
-- null) were always safe from false collisions with each other regardless
-- of the partial predicate. The only real effect of dropping "partial"
-- here is a marginally larger index; the recurring-post idempotency
-- guarantee this constraint exists for actually works now.
drop index if exists scheduled_posts_recurring_occurrence_idx;

alter table scheduled_posts
  add constraint scheduled_posts_recurring_occurrence_key
  unique (recurring_schedule_id, social_account_id, scheduled_for);
