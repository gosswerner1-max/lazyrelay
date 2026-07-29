-- Recurring schedules — "set it up once a week" content slots that generate
-- real scheduled_posts rows on a rolling window, plus pause/resume. See
-- docs/feature-spec-recurring-schedules.md for the full design and the
-- decisions this migration implements.

create table recurring_schedules (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  content text not null,
  media_url text,
  -- ISO weekday ints, 1=Mon..7=Sun — matches what a day-of-week picker UI
  -- naturally emits, no bitmask decode needed anywhere downstream.
  days_of_week smallint[] not null check (array_length(days_of_week, 1) between 1 and 7),
  -- Local wall-clock time + an explicit IANA zone, not a pre-baked UTC
  -- offset — a slot set for "9am" must keep firing at 9am through DST
  -- transitions, which a fixed offset would silently break twice a year.
  time_of_day time not null,
  timezone text not null default 'UTC',
  status text not null default 'active' check (status in ('active', 'paused')),
  starts_on date not null default current_date,
  ends_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table recurring_schedules enable row level security;

create policy "recurring_schedules_all_own" on recurring_schedules
  for all using (auth.uid() = account_id) with check (auth.uid() = account_id);

-- A slot can target multiple connected accounts at once — the entire point
-- of "set up once for all your platforms" — a junction table rather than an
-- array column so social_accounts deletion is a normal FK cascade, not
-- application-level array cleanup.
create table recurring_schedule_targets (
  recurring_schedule_id uuid not null references recurring_schedules(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  primary key (recurring_schedule_id, social_account_id)
);

alter table recurring_schedule_targets enable row level security;

create policy "recurring_schedule_targets_all_own" on recurring_schedule_targets
  for all using (
    exists (
      select 1 from recurring_schedules rs
      where rs.id = recurring_schedule_id and rs.account_id = auth.uid()
    )
  );

-- Traces which generated scheduled_posts row came from which slot, so
-- pause/resume/edit/delete can find and act on their own generated posts
-- without a fragile content/time-based guess. Nullable + on delete set null:
-- deleting a slot never cascades into deleting or orphaning already-posted
-- history, it just detaches the row, which then behaves like an ordinary
-- one-off post from that point on.
alter table scheduled_posts add column recurring_schedule_id uuid references recurring_schedules(id) on delete set null;

-- Idempotency for the generation job — prevents double-generating the same
-- occurrence if generateDuePosts() runs more than once inside the same
-- rolling window (same failure-mode class scheduler.ts's claimDuePosts()
-- already had to solve for concurrent scheduler cycles). NULLs (the
-- recurring_schedule_id column, for ordinary one-off posts) never conflict
-- with each other in a Postgres unique index, so this has zero effect on
-- non-recurring posts.
create unique index scheduled_posts_recurring_occurrence_idx
  on scheduled_posts (recurring_schedule_id, social_account_id, scheduled_for)
  where recurring_schedule_id is not null;

create index recurring_schedules_active_idx on recurring_schedules (status) where status = 'active';
