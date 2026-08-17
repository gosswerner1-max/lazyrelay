-- Custom Access Token Hook (2026-08-17) — makes Supabase's OAuth 2.1 server
-- stamp the hosted MCP server's own URI into the `aud` claim of a token it
-- mints via the /oauth/consent flow. Found live: Supabase's OAuth server
-- currently stores the `resource` parameter from an authorization request
-- but does not yet write it into the issued token's audience, so without
-- this every OAuth-issued token comes back aud="authenticated" — identical
-- to an ordinary dashboard login. backend/src/http/mcpAuth.ts's audience
-- check (the actual security boundary for the hosted MCP endpoint, since
-- the SDK's own requireBearerAuth does not validate audience) correctly
-- rejects that, which means without this hook no real MCP client can ever
-- complete the flow — not a cosmetic gap.
--
-- The `authentication_method` check is what keeps this scoped: it only
-- fires for tokens minted through the OAuth-server consent screen (an AI
-- agent connecting via /oauth/consent), never for a customer's own
-- email/password or magic-link dashboard login, which mint tokens under a
-- different authentication_method and pass through unchanged.
--
-- This function only takes effect once enabled in the Supabase dashboard:
-- Authentication -> Hooks -> Custom Access Token Hook. Applying this
-- migration alone does not change any token yet.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
as $$
declare
  claims jsonb;
begin
  claims := event->'claims';
  if event->>'authentication_method' = 'oauth_provider/authorization_code' then
    claims := jsonb_set(claims, '{aud}', '"https://lazyrelaylazyrelay-backend.onrender.com/mcp"');
  end if;
  return jsonb_build_object('claims', claims);
end;
$$;
