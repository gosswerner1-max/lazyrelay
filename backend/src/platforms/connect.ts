import { supabase } from "../supabase.js";
import type { PlatformAdapter } from "./types.js";

export type PlatformAdapterRegistry = Map<string, PlatformAdapter>;

function resolveAdapter(registry: PlatformAdapterRegistry, platform: string): PlatformAdapter {
  const adapter = registry.get(platform);
  if (!adapter) throw new Error(`"${platform}" isn't available to connect right now.`);
  return adapter;
}

/** Starts a connect flow: creates a one-time, 15-minute state token tied to
 *  this account + platform, returns the URL to redirect the user to. The
 *  adapter is resolved from the registry by `platform` — this is what lets
 *  several platforms be connectable at once instead of just one globally
 *  injected adapter. */
export async function startConnect(
  accountId: string,
  platform: string,
  registry: PlatformAdapterRegistry,
): Promise<string> {
  const adapter = resolveAdapter(registry, platform);
  const { data, error } = await supabase
    .from("oauth_states")
    .insert({ account_id: accountId, platform: adapter.platform })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create oauth state");

  return await adapter.getAuthorizeUrl(data.id);
}

/** Handles the OAuth callback: validates the state token (exists, not
 *  expired), consumes it (one-time use — deleted regardless of success, so
 *  it can never be replayed), resolves the correct adapter from the
 *  registry using the platform the state row was created for, exchanges
 *  the code for real tokens, and stores the result with the token
 *  encrypted via Vault. Returns the new social_accounts row id. */
export async function completeConnect(
  state: string,
  code: string,
  registry: PlatformAdapterRegistry,
): Promise<string> {
  const { data: stateRow, error: stateError } = await supabase
    .from("oauth_states")
    .select("account_id, platform, expires_at, pkce_verifier")
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

  // The adapter is looked up BY the platform the state row was created
  // for, not compared against a pre-selected single adapter — this makes
  // the old "platform mismatch" failure mode structurally impossible now
  // that every connect flow shares one callback route across all platforms.
  const adapter = resolveAdapter(registry, stateRow.platform);

  const result = await adapter.exchangeCode(code, stateRow.pkce_verifier ?? undefined);

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
