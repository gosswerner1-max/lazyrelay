-- Real bug found via Supabase's Security Advisor: 0001's
-- "revoke execute ... from anon, authenticated" didn't actually close
-- access, because Postgres grants EXECUTE to the implicit PUBLIC
-- pseudo-role by default on function creation, and anon/authenticated
-- are members of PUBLIC. Revoking from them individually left the
-- PUBLIC grant in place, which they still inherit through.
--
-- Fix: revoke from PUBLIC directly, then explicitly grant only to the
-- one role that should ever call these (service_role, via the backend).

revoke execute on function store_social_token(text) from public;
revoke execute on function read_social_token(uuid) from public;

grant execute on function store_social_token(text) to service_role;
grant execute on function read_social_token(uuid) to service_role;

-- Note: public.rls_auto_enable() is a Supabase-managed function created by
-- the "Enable automatic RLS" project setting, not ours — left untouched,
-- since altering it risks breaking that feature rather than fixing a real
-- access-control gap.
