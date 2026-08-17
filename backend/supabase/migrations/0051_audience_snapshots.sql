-- Audience growth tracking (2026-08-17) — the "audience growth" half of the
-- CONSIDER-tier "advanced analytics (audience growth / demographics)" item
-- from project-lazyrelay-vs-socialbee-feature-roadmap-2026-08-16. Real
-- demographic breakdowns (age/gender/location) are NOT covered by this
-- migration -- every platform gates that behind a separate, more sensitive
-- OAuth scope than what LazyRelay currently has approved (Meta's
-- read_insights, YouTube's yt-analytics.readonly, etc.), so building that
-- would mean a whole new platform-review cycle per platform, same class of
-- blocker as Google Business Profiles. Follower/subscriber COUNT over time
-- needs no new scope on Mastodon, Bluesky, or YouTube -- see
-- getFollowerCount() on PlatformAdapter.
--
-- One row per (social_account, day) -- a daily snapshot, not unlimited
-- history at poll resolution. Growth is a slow-moving number; there's no
-- value in polling it as often as engagement metrics, and daily keeps
-- storage flat and predictable regardless of how long an account's been
-- connected.

create table audience_snapshots (
  id uuid primary key default uuid_generate_v4(),
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  follower_count integer not null,
  snapshot_date date not null default current_date,
  created_at timestamptz not null default now(),
  unique (social_account_id, snapshot_date)
);

alter table audience_snapshots enable row level security;

create policy "audience_snapshots_select_own" on audience_snapshots
  for select using (auth.uid() = account_id);

create index audience_snapshots_social_account_id_idx on audience_snapshots (social_account_id);
create index audience_snapshots_account_id_date_idx on audience_snapshots (account_id, snapshot_date);
