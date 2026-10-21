-- Inactivity purge, part 2 (ops/accounts/inactivity_purge_ops.js).
--
-- 1. A new activity signal: the Supabase auth session time. A person who only browses the dashboard refreshes their token
--    without a new sign in, so auth.users.last_sign_in_at alone would call them inactive. auth.sessions is not readable
--    through PostgREST, so a SECURITY DEFINER function reads it for the ops scripts. It is executable by the service role
--    only (revoked from public, anon and authenticated), the search_path is pinned, and it returns nothing but the newest
--    activity time per account id that is passed in.
-- 2. accounts.inactivity_warned_at: when the "your data will be deleted" warning email was sent. The purge only acts on an
--    account whose warning is set and at least 14 days old; the warning sweep clears it when activity is seen again.
--
-- Idempotent: safe to run more than once. Not applied by the pull request; apply it deliberately.

alter table public.accounts add column if not exists inactivity_warned_at timestamptz;

comment on column public.accounts.inactivity_warned_at is
  'When the inactivity warning email was sent for the current inactivity period. Cleared when activity is seen again. The inactivity purge requires it to be set and at least 14 days old.';

-- auth.sessions.refreshed_at is a timestamp without time zone (UTC) on some Supabase versions and a timestamptz on others.
-- Casting to timestamp under a pinned UTC time zone and then reading it "at time zone UTC" is correct for both.
create or replace function public.inactivity_last_session_activity(p_account_ids uuid[])
returns table (account_id uuid, last_activity timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, auth
set timezone = 'UTC'
as $$
  select
    s.user_id as account_id,
    max(greatest(
      s.created_at,
      s.updated_at,
      (s.refreshed_at::timestamp) at time zone 'UTC'
    )) as last_activity
  from auth.sessions s
  where s.user_id = any (p_account_ids)
  group by s.user_id;
$$;

revoke all on function public.inactivity_last_session_activity(uuid[]) from public;
revoke all on function public.inactivity_last_session_activity(uuid[]) from anon;
revoke all on function public.inactivity_last_session_activity(uuid[]) from authenticated;
grant execute on function public.inactivity_last_session_activity(uuid[]) to service_role;

comment on function public.inactivity_last_session_activity(uuid[]) is
  'Newest auth.sessions activity (created, updated, refreshed) per account id. Service role only. Used by the inactivity purge so a person who only browses with token refreshes is never counted as inactive.';
