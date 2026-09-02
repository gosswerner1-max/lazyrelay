// Shared on-demand token refresh for any Google-OAuth-backed connection
// table shaped like {access_token_vault_id, refresh_token_vault_id,
// token_expires_at} -- same 5-min expiry skew, refresh-only-when-needed
// pattern originally written once for googleCalendar/tokens.ts. Pulled out
// here 2026-09-02 when googleSheets/tokens.ts needed the identical logic --
// two copies of this exact dance (read expiry, decide refresh-or-not,
// read/update vault tokens, persist new expiry) is exactly the shape that
// quietly drifts when one gets a bugfix the other doesn't, so it's shared
// rather than duplicated a second time.
//
// Each feature keeps its own tiny oauthClient.ts (own scope, own
// authorize/exchange, own env vars) -- only this refresh orchestration is
// generic across features, not the OAuth client itself.

import { supabase } from "../supabase.js";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface RefreshedGoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

interface ConnectionTokenRow {
  access_token_vault_id: string;
  refresh_token_vault_id: string | null;
  token_expires_at: string | null;
}

/** Returns a live access token for a row in `table` (any table with the
 *  three columns above), refreshing and persisting a new one first if the
 *  stored token is expired or about to be. `refreshTokens` is the calling
 *  feature's own oauthClient.refreshTokens (different client id/secret or
 *  scope per feature, so this stays feature-agnostic). Throws if the
 *  connection doesn't exist or has no usable refresh token once expired. */
export async function getGoogleAccessToken(
  table: string,
  connectionId: string,
  refreshTokens: (refreshToken: string) => Promise<RefreshedGoogleTokens>,
): Promise<string> {
  const { data: row, error } = await supabase
    .from(table)
    .select("access_token_vault_id, refresh_token_vault_id, token_expires_at")
    .eq("id", connectionId)
    .single();
  if (error || !row) throw error ?? new Error(`${table} connection not found`);
  const connection = row as ConnectionTokenRow;

  const isExpired =
    connection.token_expires_at !== null &&
    new Date(connection.token_expires_at).getTime() - TOKEN_REFRESH_SKEW_MS < Date.now();

  if (!isExpired) {
    const { data: token, error: readError } = await supabase.rpc("read_social_token", {
      p_vault_id: connection.access_token_vault_id,
    });
    if (readError) throw readError;
    return token as string;
  }

  if (!connection.refresh_token_vault_id) {
    throw new Error(`${table} token expired and no refresh token is on file — the customer needs to reconnect`);
  }

  const { data: storedRefreshToken, error: refreshReadError } = await supabase.rpc("read_social_token", {
    p_vault_id: connection.refresh_token_vault_id,
  });
  if (refreshReadError) throw refreshReadError;

  const refreshed = await refreshTokens(storedRefreshToken as string);

  const { error: updateAccessError } = await supabase.rpc("update_social_token", {
    p_vault_id: connection.access_token_vault_id,
    p_new_token: refreshed.accessToken,
  });
  if (updateAccessError) throw updateAccessError;

  if (refreshed.refreshToken && refreshed.refreshToken !== storedRefreshToken) {
    await supabase.rpc("update_social_token", {
      p_vault_id: connection.refresh_token_vault_id,
      p_new_token: refreshed.refreshToken,
    });
  }

  await supabase
    .from(table)
    .update({ token_expires_at: refreshed.expiresAt })
    .eq("id", connectionId);

  return refreshed.accessToken;
}
