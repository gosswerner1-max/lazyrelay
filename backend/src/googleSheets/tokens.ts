// On-demand token refresh for a Google Sheets connection -- thin wrapper
// around the shared googleOAuth/tokenStore.ts, same pattern as
// googleCalendar/tokens.ts.

import { getGoogleAccessToken as getGoogleAccessTokenGeneric } from "../googleOAuth/tokenStore.js";
import { refreshTokens } from "./oauthClient.js";

const TABLE = "google_sheets_connections";

/** Returns a live access token for the given google_sheets_connections row,
 *  refreshing and persisting a new one first if the stored token is expired
 *  or about to be. Throws if the connection doesn't exist or has no usable
 *  refresh token once expired. */
export async function getGoogleAccessToken(connectionId: string): Promise<string> {
  return getGoogleAccessTokenGeneric(TABLE, connectionId, refreshTokens);
}
