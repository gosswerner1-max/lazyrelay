-- Real engagement analytics (likes/comments/shares/views) — the #1 gap found
-- in the 2026-08-07 competitor audit: every competitor researched has some
-- form of this, several even at their free/entry tier, and LazyRelay had
-- nothing beyond its own operational post-count data.
--
-- Bounded snapshot design, not unlimited history: one row per
-- (scheduled_post, checkpoint), never one row per poll forever. Six fixed
-- checkpoints per post, then polling for that post stops — gives a real
-- growth-curve read ("most engagement landed in the first 6 hours") that
-- competitors' flat "current totals" don't show, while keeping storage cost
-- fixed and predictable regardless of how long a post has been live. See
-- werner-brain vault: project-competitor-feature-audit-2026-08-07.md.
--
-- Checkpoints are measured from post_results.verification_checked_at (when
-- Proof-of-Publish actually confirmed the post live), not scheduled_for —
-- that's when real engagement starts accumulating, not when it was queued.

create table post_metrics (
  id uuid primary key default uuid_generate_v4(),
  scheduled_post_id uuid not null references scheduled_posts(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  checkpoint text not null check (checkpoint in ('1h', '6h', '24h', '3d', '7d', '30d')),
  likes integer,
  comments integer,
  shares integer,
  views integer,
  error_message text,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (scheduled_post_id, checkpoint)
);

alter table post_metrics enable row level security;

create policy "post_metrics_select_own" on post_metrics
  for select using (auth.uid() = account_id);

create index post_metrics_scheduled_post_id_idx on post_metrics (scheduled_post_id);
