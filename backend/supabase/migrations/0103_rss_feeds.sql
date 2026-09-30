-- RSS-to-drafts: a customer adds a feed; new items become DRAFTS in their
-- dashboard (never posts). seen_ids remembers item ids already turned into a
-- draft (capped in code) so an item is never drafted twice. RLS on, no
-- policies: only the backend's service-role key touches it, filtered by
-- account_id.

create table if not exists rss_feeds (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  url text not null,
  label text,
  enabled boolean not null default true,
  seen_ids text[] not null default '{}',
  primed boolean not null default false,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists rss_feeds_account_idx on rss_feeds (account_id);
create index if not exists rss_feeds_due_idx on rss_feeds (last_checked_at) where enabled;

alter table rss_feeds enable row level security;
