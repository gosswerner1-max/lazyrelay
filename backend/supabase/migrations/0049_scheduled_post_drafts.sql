-- Drafts (2026-08-16) — save compose-form content for later without
-- committing to an account or a time yet, same concept as every competitor
-- (SocialBee, Buffer, etc.) has and LazyRelay didn't. A draft is a real
-- scheduled_posts row with status='draft' — both social_account_id and
-- scheduled_for are relaxed to nullable to allow this; every other status
-- (pending/posting/posted/failed/needs_approval) still always has both set,
-- enforced at the application layer in routes.ts, not by the DB.
--
-- scheduled_posts_pending_idx (migration 0001) is a partial index
-- `where status = 'pending'` -- unaffected, since drafts are never status
-- 'pending'. claimDuePosts (scheduler.ts) only ever selects status='pending'
-- too, so a draft is naturally invisible to the scheduler without any
-- change there.
alter table scheduled_posts alter column social_account_id drop not null;
alter table scheduled_posts alter column scheduled_for drop not null;

alter table scheduled_posts drop constraint scheduled_posts_status_check;
alter table scheduled_posts add constraint scheduled_posts_status_check
  check (status in ('draft', 'pending', 'posting', 'posted', 'failed', 'needs_approval'));
