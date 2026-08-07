-- DM automation (2026-08-07) — priority (5) from the 2026-08-07
-- competitor audit: comment/keyword -> auto-DM for Facebook + Instagram,
-- the one place a prospective customer could pick Blotato over LazyRelay
-- for a concrete, named reason (Blotato ships this at the same $29/mo).
--
-- scheduled_post_id null means "applies to every post on this social
-- account", not just one — a customer running a giveaway across several
-- posts shouldn't have to create a separate rule per post.
-- keyword null means "matches every comment" (the plain "comment and
-- I'll DM you" pattern, no filtering).
create table dm_automations (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  scheduled_post_id uuid references scheduled_posts(id) on delete cascade,
  keyword text,
  dm_message text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index dm_automations_account_id_idx on dm_automations (account_id);
create index dm_automations_social_account_id_idx on dm_automations (social_account_id);

alter table dm_automations enable row level security;

-- Dedup log — the poller checks this before ever sending, so the same
-- commenter is never DMed twice for the same rule even across restarts.
-- The unique constraint is the actual guarantee, not just the app-level
-- check (a poller run overlapping itself must never double-send).
create table dm_automation_log (
  id uuid primary key default uuid_generate_v4(),
  automation_id uuid not null references dm_automations(id) on delete cascade,
  comment_id text not null,
  triggered_at timestamptz not null default now(),
  unique (automation_id, comment_id)
);

create index dm_automation_log_automation_id_idx on dm_automation_log (automation_id);

alter table dm_automation_log enable row level security;
