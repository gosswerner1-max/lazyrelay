-- Posting slots: times a customer likes to post (e.g. Mon/Wed/Fri 09:00 in their
-- own timezone). "Next free slot" (backend/src/postingSlots.ts) picks the first
-- future occurrence no post on the channel already uses. RLS on, no policies:
-- only the backend's service-role key reads or writes it, always filtered by
-- account_id.

create table if not exists posting_slots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  days_of_week int[] not null,
  time_of_day text not null,
  timezone text not null,
  created_at timestamptz not null default now()
);

create index if not exists posting_slots_account_idx on posting_slots (account_id);

alter table posting_slots enable row level security;
