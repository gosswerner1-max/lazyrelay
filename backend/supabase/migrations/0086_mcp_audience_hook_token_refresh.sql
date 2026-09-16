-- Custom Access Token Hook, fixed for token refresh (2026-09-14).
--
-- 0052 only stamped the MCP audience when authentication_method was
-- 'oauth_provider/authorization_code', i.e. the first token from the
-- /oauth/consent flow. Supabase runs this hook on every token issuance, and a
-- refresh arrives as authentication_method 'token_refresh' (per Supabase's
-- custom-access-token-hook docs). So every refreshed token came back
-- aud="authenticated", mcpAuth.ts rejected it as an ordinary session token,
-- and every hosted MCP connection died one hour after connecting. Found live
-- 2026-09-14: a refreshed token decoded to aud="authenticated" with
-- amr oauth_provider/authorization_code and a client_id claim.
--
-- The fix keys on the client_id claim as well. Supabase only puts client_id
-- in the claims of tokens issued to an OAuth client, on the first mint and on
-- refresh. A customer's own dashboard login (password, magic link, Google
-- sign-in, and its refreshes) carries no client_id, so it still passes
-- through unchanged and mcpAuth.ts still rejects it. Scope is the same as
-- 0052: any token belonging to an OAuth-server client gets the MCP audience,
-- now including its refreshes.
--
-- create or replace keeps the existing grants, so 0055's revoke from public /
-- grant to supabase_auth_admin stays in force. The hook is already enabled in
-- the dashboard (Authentication -> Auth Hooks), so this takes effect as soon
-- as it is applied.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
as $$
declare
  claims jsonb;
begin
  claims := event->'claims';
  if event->>'authentication_method' = 'oauth_provider/authorization_code'
     or coalesce(claims->>'client_id', '') <> '' then
    claims := jsonb_set(claims, '{aud}', '"https://lazyrelaylazyrelay-backend.onrender.com/mcp"');
  end if;
  return jsonb_build_object('claims', claims);
end;
$$;
