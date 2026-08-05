-- Read-only helper functions for the Health & Safety ops check (ops/health/).
-- Both are SECURITY DEFINER so the service-role ops client can call them via
-- RPC without needing direct schema access beyond what's already granted —
-- same low-privilege pattern as every other ops/ read. Neither function
-- mutates anything.

create or replace function ops_db_size_bytes()
returns bigint
language sql
security definer
set search_path = public
as $$
  select pg_database_size(current_database());
$$;

-- Proxy for Supabase's billed Monthly Active Users (real MAU counts any API
-- activity — login or token refresh — which isn't independently queryable
-- from inside Postgres). Distinct users with a sign-in in the given window
-- is a conservative under-count of the real billed figure, never an
-- over-count, so this is safe to alert on early without risking a false
-- "all clear."
create or replace function ops_monthly_active_users(cycle_start timestamptz)
returns bigint
language sql
security definer
set search_path = public
as $$
  select count(distinct id) from auth.users where last_sign_in_at >= cycle_start;
$$;

revoke all on function ops_db_size_bytes() from public;
revoke all on function ops_monthly_active_users(timestamptz) from public;
grant execute on function ops_db_size_bytes() to service_role;
grant execute on function ops_monthly_active_users(timestamptz) to service_role;
