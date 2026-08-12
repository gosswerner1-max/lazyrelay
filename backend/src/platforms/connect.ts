import { supabase } from "../supabase.js";
import type { PlatformAdapter, OAuthExchangeResult, ConnectOption } from "./types.js";

export type PlatformAdapterRegistry = Map<string, PlatformAdapter>;

export type CompleteConnectResult =
  | { status: "connected"; socialAccountId: string }
  | { status: "needs_selection"; selectionToken: string; options: ConnectOption[] };

function resolveAdapter(registry: PlatformAdapterRegistry, platform: string): PlatformAdapter {
  const adapter = registry.get(platform);
  if (!adapter) throw new Error(`"${platform}" isn't available to connect right now.`);
  return adapter;
}

// Shared by the plain single-account path and both branches of the
// picker path (auto-finalized single option, and a real customer pick) —
// same upsert-on-reconnect behavior either way.
async function storeConnectedAccount(
  accountId: string,
  platform: string,
  result: OAuthExchangeResult,
): Promise<string> {
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

  // Upsert, not insert: reconnecting a platform you're already connected to
  // (same account_id + platform + platform_account_id, which is unique) is
  // the common case, not an edge case — a token refresh, a re-auth after
  // revoking scopes, or just clicking "Connect" again. A plain insert hits
  // that unique constraint and fails, but the OAuth redirect back to the
  // dashboard happens regardless, so the failure was invisible: the user
  // sees what looks like a successful reconnect while the old, possibly
  // expired token silently stays in place and every post keeps using it.
  const { data: socialAccount, error: insertError } = await supabase
    .from("social_accounts")
    .upsert(
      {
        account_id: accountId,
        platform,
        platform_account_id: result.platformAccountId,
        display_name: result.displayName,
        access_token_vault_id: accessVaultId,
        refresh_token_vault_id: refreshVaultId,
        token_expires_at: result.expiresAt,
        disconnected_at: null,
      },
      { onConflict: "account_id,platform,platform_account_id" },
    )
    .select("id")
    .single();
  if (insertError || !socialAccount) throw insertError;

  return socialAccount.id;
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
 *  expired), resolves the correct adapter from the registry using the
 *  platform the state row was created for, and exchanges the code for real
 *  tokens.
 *
 *  Most adapters finish here: the state row is consumed (deleted — one-time
 *  use no matter what happens next, success or failure) and the result is
 *  stored with the token encrypted via Vault.
 *
 *  Adapters that declare listConnectOptions (currently Facebook/Instagram,
 *  where one login can map to several Pages/IG accounts) take a different
 *  path: if there's more than one real option, the state row is NOT
 *  deleted — instead it's updated to hold the candidate list and the
 *  long-lived user token (vault-encrypted), and this returns
 *  "needs_selection" so the customer can pick before anything is finalized.
 *  Exactly one option still finalizes immediately, same UX as a plain
 *  connect. */
export async function completeConnect(
  state: string,
  code: string,
  registry: PlatformAdapterRegistry,
): Promise<CompleteConnectResult> {
  const { data: stateRow, error: stateError } = await supabase
    .from("oauth_states")
    .select("account_id, platform, expires_at, pkce_verifier")
    .eq("id", state)
    .single();

  if (stateError || !stateRow) {
    throw new Error("Invalid or already-used connect link");
  }
  if (new Date(stateRow.expires_at) < new Date()) {
    await supabase.from("oauth_states").delete().eq("id", state);
    throw new Error("Connect link expired — please try connecting again");
  }

  // The adapter is looked up BY the platform the state row was created
  // for, not compared against a pre-selected single adapter — this makes
  // the old "platform mismatch" failure mode structurally impossible now
  // that every connect flow shares one callback route across all platforms.
  const adapter = resolveAdapter(registry, stateRow.platform);

  if (adapter.listConnectOptions) {
    const { userToken, options } = await adapter.listConnectOptions(code, stateRow.pkce_verifier ?? undefined);

    if (options.length === 0) {
      await supabase.from("oauth_states").delete().eq("id", state);
      throw new Error("No eligible account found to connect");
    }

    if (options.length === 1) {
      // Nothing to actually pick — finalize immediately rather than make
      // the customer click through a picker with one entry.
      await supabase.from("oauth_states").delete().eq("id", state);
      const result = await adapter.finalizeConnectOption!(userToken, options[0].id);
      const socialAccountId = await storeConnectedAccount(stateRow.account_id, adapter.platform, result);
      return { status: "connected", socialAccountId };
    }

    // Real choice to make — hold the long-lived token against THIS state
    // row instead of deleting it, so the frontend's follow-up "finalize"
    // call has something to reference. Reuses oauth_states' existing
    // expiry as the picker's own timeout.
    const { data: tokenVaultId, error: vaultError } = await supabase.rpc("store_social_token", {
      p_token: userToken,
    });
    if (vaultError) throw vaultError;

    const { error: updateError } = await supabase
      .from("oauth_states")
      .update({ pending_options: options, pending_token_vault_id: tokenVaultId })
      .eq("id", state);
    if (updateError) throw updateError;

    return { status: "needs_selection", selectionToken: state, options };
  }

  // Delete immediately, before doing anything else — one-time use no
  // matter what happens next, success or failure.
  await supabase.from("oauth_states").delete().eq("id", state);
  const result = await adapter.exchangeCode(code, stateRow.pkce_verifier ?? undefined);
  const socialAccountId = await storeConnectedAccount(stateRow.account_id, adapter.platform, result);
  return { status: "connected", socialAccountId };
}

/** Reads back the pending Page/account options for a "needs_selection"
 *  connect, scoped to the LazyRelay account that started the flow (so one
 *  customer can never read or complete another's in-flight connect). */
export async function getPendingSelection(
  selectionToken: string,
  accountId: string | undefined,
): Promise<{ platform: string; options: ConnectOption[] }> {
  const { data: stateRow, error } = await supabase
    .from("oauth_states")
    .select("account_id, platform, expires_at, pending_options")
    .eq("id", selectionToken)
    .single();
  if (error || !stateRow || !stateRow.pending_options) {
    throw new Error("Invalid or already-used selection link");
  }
  if (stateRow.account_id !== accountId) {
    throw new Error("Not authorized for this selection");
  }
  if (new Date(stateRow.expires_at) < new Date()) {
    await supabase.from("oauth_states").delete().eq("id", selectionToken);
    throw new Error("Selection expired — please reconnect");
  }
  return { platform: stateRow.platform, options: stateRow.pending_options as ConnectOption[] };
}

/** Finishes a "needs_selection" connect once the customer has picked one of
 *  the options getPendingSelection returned. One-time use like the main
 *  callback — the state row is deleted regardless of outcome. */
export async function finalizeConnectSelection(
  selectionToken: string,
  selectedId: string,
  accountId: string | undefined,
  registry: PlatformAdapterRegistry,
): Promise<string> {
  const { data: stateRow, error } = await supabase
    .from("oauth_states")
    .select("account_id, platform, expires_at, pending_options, pending_token_vault_id")
    .eq("id", selectionToken)
    .single();

  // Delete immediately, before doing anything else — one-time use no
  // matter what happens next, success or failure.
  await supabase.from("oauth_states").delete().eq("id", selectionToken);

  if (error || !stateRow || !stateRow.pending_token_vault_id) {
    throw new Error("Invalid or already-used selection link");
  }
  if (stateRow.account_id !== accountId) {
    throw new Error("Not authorized for this selection");
  }
  if (new Date(stateRow.expires_at) < new Date()) {
    throw new Error("Selection expired — please reconnect");
  }
  const options = (stateRow.pending_options ?? []) as ConnectOption[];
  if (!options.some((o) => o.id === selectedId)) {
    throw new Error("That option wasn't part of the original list — please reconnect");
  }

  const adapter = resolveAdapter(registry, stateRow.platform);
  if (!adapter.finalizeConnectOption) {
    throw new Error("This platform doesn't support selection");
  }

  const { data: userToken, error: tokenError } = await supabase.rpc("read_social_token", {
    p_vault_id: stateRow.pending_token_vault_id,
  });
  if (tokenError || !userToken) throw tokenError ?? new Error("Could not retrieve the pending token");

  const result = await adapter.finalizeConnectOption(userToken, selectedId);
  return await storeConnectedAccount(stateRow.account_id, adapter.platform, result);
}
