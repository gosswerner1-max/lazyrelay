-- Real bug found in a security review, 2026-08-19: increment_ai_generation_usage
-- (0028_ai_generation_usage.sql) is security definer and takes p_account_id as
-- a caller-supplied parameter with no ownership check in the function body —
-- exactly the class of bug 0003 already fixed once for store/read_social_token,
-- but this function (created later, in 0028) never got the same treatment.
-- Postgres grants EXECUTE to the implicit PUBLIC pseudo-role by default, so
-- PostgREST auto-exposes it at POST /rest/v1/rpc/increment_ai_generation_usage
-- callable by anyone holding only the public anon key, with any account_id —
-- letting an attacker who knows/guesses a target account's UUID burn through
-- that account's daily AI-generation cap on their behalf. Same fix as 0003:
-- revoke from PUBLIC, grant only to service_role (the backend already calls
-- this exclusively via its service-role client, aiUsage.ts).

revoke execute on function increment_ai_generation_usage(uuid, date) from public;
grant execute on function increment_ai_generation_usage(uuid, date) to service_role;

-- Same review flagged custom_access_token_hook (0052_mcp_oauth_audience_hook.sql)
-- as missing its own explicit grant/revoke too. Not attacker-reachable the way
-- the function above was (it's a pure transform over caller-supplied JWT
-- claims — a direct RPC call leaks nothing beyond what the caller already
-- has), but Supabase's own hardening guidance for auth hooks is that only
-- supabase_auth_admin should be able to invoke them. Tightened here as
-- defense-in-depth while this same class of gap is already being closed.
revoke execute on function custom_access_token_hook(jsonb) from public;
grant execute on function custom_access_token_hook(jsonb) to supabase_auth_admin;
