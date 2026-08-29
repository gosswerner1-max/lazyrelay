// On-demand token refresh for a Google Calendar connection -- same pattern
// as scheduler.ts's getAccessToken() (5-min expiry skew, refresh only when
// actually needed), not a scheduled refresh job. Kept as its own small
// module rather than importing scheduler.ts, which has no exports for this
// and is scoped to the post-publishing pipeline.

import { supabase } from "../supabase.js";
import { refreshTokens } from "./oauthClient.js";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Returns a live access token for the given google_calendar_connections
 *  row, refreshing and persisting a new one first if the stored token is
 *  expired or about to be. Throws if the connection doesn't exist or has no
 *  usable refresh token once expired. */
export async function getGoogleAccessToken(connectionId: string): Promise<string> {
  const { data: connection, error } = await supabase
    .from("google_calendar_connections")
    .select("access_token_vault_id, refresh_token_vault_id, token_expires_at")
    .eq("id", connectionId)
    .single();
  if (error || !connection) throw error ?? new Error("Google Calendar connection not found");

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
    throw new Error("Google Calendar token expired and no refresh token is on file — the customer needs to reconnect");
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
    .from("google_calendar_connections")
    .update({ token_expires_at: refreshed.expiresAt })
    .eq("id", connectionId);

  return refreshed.accessToken;
}
