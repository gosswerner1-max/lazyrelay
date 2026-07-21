import { supabase } from "../supabase.js";
import type { PlatformAdapter } from "./types.js";

/** Starts a connect flow: creates a one-time, 15-minute state token tied to
 *  this account + platform, returns the URL to redirect the user to. */
export async function startConnect(
  accountId: string,
  adapter: PlatformAdapter,
): Promise<string> {
  const { data, error } = await supabase
    .from("oauth_states")
    .insert({ account_id: accountId, platform: adapter.platform })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create oauth state");

  return adapter.getAuthorizeUrl(data.id);
}

/** Handles the OAuth callback: validates the state token (exists, not
 *  expired, matches the platform), consumes it (one-time use — deleted
 *  regardless of success, so it can never be replayed), exchanges the code
 *  for real tokens, and stores the result with the token encrypted via
 *  Vault. Returns the new social_accounts row id. */
export async function completeConnect(
  state: string,
  code: string,
  adapter: PlatformAdapter,
): Promise<string> {
  const { data: stateRow, error: stateError } = await supabase
    .from("oauth_states")
    .select("account_id, platform, expires_at")
    .eq("id", state)
    .single();

  // Delete immediately, before doing anything else — one-time use no
  // matter what happens next, success or failure.
  await supabase.from("oauth_states").delete().eq("id", state);

  if (stateError || !stateRow) {
    throw new Error("Invalid or already-used connect link");
  }
  if (new Date(stateRow.expires_at) < new Date()) {
    throw new Error("Connect link expired — please try connecting again");
  }
  if (stateRow.platform !== adapter.platform) {
    throw new Error("Platform mismatch on connect callback");
  }

  const result = await adapter.exchangeCode(code);

  const { data: accessVaultId, error: accessVaultError } = await supabase.rpc("store_social_token", {
    p_token: result.accessToken,
  });
  if (accessVaultError) throw accessVaultError;

  let refreshVaultId: string | null = null;
  if (result.refreshToken) {
    const { data, error } = await supabase.rpc("store_social_token", { p_token: result.refreshToken });
    if (error) throw error;
    refreshVaultId = data;
  }

  const { data: socialAccount, error: insertError } = await supabase
    .from("social_accounts")
    .insert({
      account_id: stateRow.account_id,
      platform: adapter.platform,
      platform_account_id: result.platformAccountId,
      display_name: result.displayName,
      access_token_vault_id: accessVaultId,
      refresh_token_vault_id: refreshVaultId,
      token_expires_at: result.expiresAt,
    })
    .select("id")
    .single();
  if (insertError || !socialAccount) throw insertError;

  return socialAccount.id;
}
