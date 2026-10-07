-- Privacy: do what the DPA and the Data Deletion page say (decided by Werner 2026-10-07).
--
--   1. A disconnected connection's stored login is wiped. tokens_wiped_at records when the Vault secrets behind a row
--      were overwritten. The backend wipes at disconnect time (and when a reconnect replaces a login); a sweep wipes
--      any row that is disconnected but not yet wiped, which also covers every connection disconnected before today.
--   2. Cached comment text and DM snippets are deleted once they fall outside the 30 day tracking window (the same window
--      the Mentions poller reads: posts scheduled in the last 30 days). purge_stored_messages() does the deleting; the
--      backend calls it from the 6 hourly job.
--
-- Not applied to any database by this file being merged. Applied by hand, with Werner's yes.
--
-- Wrapped in one transaction: all of it applies, or none of it does.

begin;

alter table social_accounts add column tokens_wiped_at timestamptz;
alter table google_calendar_connections add column tokens_wiped_at timestamptz;
alter table google_sheets_connections add column tokens_wiped_at timestamptz;

-- The sweep's question: which disconnected rows still hold a login? Partial, so it stays tiny.
create index social_accounts_wipe_pending_idx on social_accounts (disconnected_at)
  where disconnected_at is not null and tokens_wiped_at is null;

-- Deletes cached comments and DM snippets older than p_cutoff. A comment goes when its post was scheduled before the
-- cutoff (a comment cannot be older than its post) or when its own date is before it; a DM conversation goes when it was
-- last updated before the cutoff (or, when the platform gave no date, first seen before it). Returns what was deleted.
create function purge_stored_messages(p_cutoff timestamptz)
returns table (comments_deleted bigint, dms_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_comments bigint;
  v_dms bigint;
begin
  with gone as (
    delete from mention_comments_cache m
    where coalesce(m.comment_created_at, m.first_seen_at) < p_cutoff
       or exists (select 1 from scheduled_posts p where p.id = m.scheduled_post_id and p.scheduled_for < p_cutoff)
    returning 1
  )
  select count(*) into v_comments from gone;

  with gone as (
    delete from dm_conversations_cache d
    where coalesce(d.conversation_updated_at, d.first_seen_at) < p_cutoff
    returning 1
  )
  select count(*) into v_dms from gone;

  return query select v_comments, v_dms;
end;
$$;

-- Only the backend's service-role client may call it.
revoke execute on function purge_stored_messages(timestamptz) from public, anon, authenticated;
grant execute on function purge_stored_messages(timestamptz) to service_role;

commit;
