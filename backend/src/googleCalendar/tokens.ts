// On-demand token refresh for a Google Calendar connection -- thin wrapper
// around the shared googleOAuth/tokenStore.ts (pulled out 2026-09-02 when
// googleSheets/tokens.ts needed the identical refresh orchestration; see
// that file's header for why it's shared rather than duplicated).

import { getGoogleAccessToken as getGoogleAccessTokenGeneric } from "../googleOAuth/tokenStore.js";
import { refreshTokens } from "./oauthClient.js";

const TABLE = "google_calendar_connections";

/** Returns a live access token for the given google_calendar_connections
 *  row, refreshing and persisting a new one first if the stored token is
 *  expired or about to be. Throws if the connection doesn't exist or has no
 *  usable refresh token once expired. */
export async function getGoogleAccessToken(connectionId: string): Promise<string> {
  return getGoogleAccessTokenGeneric(TABLE, connectionId, refreshTokens);
}
