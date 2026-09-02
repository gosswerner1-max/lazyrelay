// OAuth client for the Google Sheets content-calendar export. Deliberately
// REUSES the same GOOGLE_CALENDAR_CLIENT_ID/SECRET as googleCalendar/
// oauthClient.ts rather than provisioning a brand-new OAuth client --
// unlike Calendar's own choice to get a dedicated Google Cloud PROJECT
// (isolating its review from the shared "LazyRelay" project's stuck YouTube
// scope mess, see that file's header comment), Sheets already lives in the
// SAME `lazyrelay-calendar` project and the SAME Data Access review as
// Calendar -- there's no isolation benefit left to buy with a second OAuth
// client, and reusing one means Werner sets one fewer secret. Only the
// scope and redirect URI differ per flow; one Google Cloud OAuth client can
// carry multiple authorized redirect URIs and be used for multiple
// independent authorize flows.
//
// Scope: `drive.file` -- "See, edit, create, and delete only the specific
// Google Drive files you use with this app." Confirmed live in Console's
// Data Access page 2026-09-02: genuinely non-sensitive, no verification
// review needed for this scope on its own. The important constraint this
// implies: the app can only ever access files IT creates via this token --
// never an existing file the customer already has (that needs Google's
// Picker widget instead, deliberately out of scope for v1 -- see
// connect.ts).
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/drive.file";
// Same non-sensitive "email" scope Calendar added, same reason: show
// "Connected as ..." instead of just "Connected."
const USERINFO_SCOPE = "email";

function getClientConfig() {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_SHEETS_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }
  return { clientId, clientSecret, redirectUri };
}

/** Whether Google Sheets export is configured at all in this environment --
 *  same "absent unless configured" pattern as isGoogleCalendarConfigured. */
export function isGoogleSheetsConfigured(): boolean {
  return getClientConfig() !== null;
}

export function getAuthorizeUrl(state: string): string {
  const config = getClientConfig();
  if (!config) throw new Error("Google Sheets export isn't configured on this server");
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: `${SHEETS_SCOPE} ${USERINFO_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const config = getClientConfig();
  if (!config) throw new Error("Google Sheets export isn't configured on this server");
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description ?? json.error ?? "Google Sheets token exchange failed");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
  };
}

/** Best-effort only -- called once at connect time purely to label the
 *  connection back to the customer ("Connected as ..."). Never blocks or
 *  fails the connect flow if it errors. */
export async function fetchConnectedEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { email?: string };
    return json.email ?? null;
  } catch {
    return null;
  }
}

export async function refreshTokens(refreshToken: string): Promise<GoogleTokens> {
  const config = getClientConfig();
  if (!config) throw new Error("Google Sheets export isn't configured on this server");
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description ?? json.error ?? "Google Sheets token refresh failed");
  }
  return {
    accessToken: json.access_token,
    // Google only returns a new refresh_token occasionally (e.g. re-consent)
    // -- keep the existing one when it doesn't, same fallback every other
    // adapter's refresh() uses.
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
  };
}
