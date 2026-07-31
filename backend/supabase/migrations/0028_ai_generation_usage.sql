-- Tracks daily AI caption/hashtag generation usage per account (2026-07-31),
-- added specifically to cap real Anthropic API spend — without this, a
-- customer could call /api/ai/caption or /api/ai/hashtags unlimited times
-- per day with no cost ceiling. One row per (account_id, usage_date);
-- upserted and incremented atomically from aiUsage.ts before each generation
-- call. Both caption and hashtag calls share one combined daily counter —
-- deliberately simple, not two separate limits, since both hit the same
-- Anthropic bill.
--
-- No client-facing RLS policies, same fail-closed-by-omission pattern as
-- oauth_states/media_uploads/storage_addons — only the backend's
-- service-role client ever touches this table.
create table ai_generation_usage (
  account_id uuid not null references accounts(id) on delete cascade,
  usage_date date not null,
  generation_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (account_id, usage_date)
);

alter table ai_generation_usage enable row level security;

-- Atomic upsert-increment, called from aiUsage.ts's recordGeneration() via
-- supabase.rpc(). Using a DB function instead of a read-then-write from the
-- app avoids a race where two concurrent requests from the same account
-- both read the same pre-increment count and both pass the cap check.
create function increment_ai_generation_usage(p_account_id uuid, p_usage_date date)
returns void
language sql
security definer
as $$
  insert into ai_generation_usage (account_id, usage_date, generation_count, updated_at)
  values (p_account_id, p_usage_date, 1, now())
  on conflict (account_id, usage_date)
  do update set generation_count = ai_generation_usage.generation_count + 1, updated_at = now();
$$;
