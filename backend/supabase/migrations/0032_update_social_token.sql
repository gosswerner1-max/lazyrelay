-- Real bug: no way to rotate a Vault-stored OAuth token in place once it
-- expires. store_social_token() only creates NEW secrets (used at connect
-- time); the scheduler had no refresh path at all, so any platform with
-- short-lived access tokens (TikTok confirmed — access token dead within a
-- day, refresh token captured at connect time but never used) silently
-- breaks every post until the customer manually reconnects. This lets a
-- refresh flow overwrite an existing vault secret's value in place, so
-- social_accounts.access_token_vault_id/refresh_token_vault_id stay valid
-- (no update needed on social_accounts itself for the token columns).

create or replace function update_social_token(p_vault_id uuid, p_new_token text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  perform vault.update_secret(p_vault_id, p_new_token);
end;
$$;

revoke execute on function update_social_token(uuid, text) from public;
grant execute on function update_social_token(uuid, text) to service_role;
