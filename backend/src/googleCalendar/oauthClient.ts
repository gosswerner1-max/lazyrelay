// OAuth client for Google Calendar. Deliberately a NEW, separate Google
// Cloud OAuth client from the one Google Business Profile uses
// (platforms/googleBusiness.ts) -- that client's own app-verification status
// is already fragile/untested, and tying a second sensitive scope to it
// would risk both features' review state together. Same raw-fetch()
// pattern as googleBusiness.ts (and every other adapter in this codebase)
// -- no googleapis npm package, no OAuth library.
//
// Scope note, revised 2026-08-31: `calendar.events` (narrower, easier to
// get through Google's sensitive-scope verification review) only covers
// event CRUD -- it does NOT cover calendars.insert, which this feature
// needs once, at connect time, to create the dedicated "LazyRelay Posts"
// calendar. That's a calendar-RESOURCE operation, not an event operation,
// per Google's own scope-to-endpoint documentation.
//
// `calendar.app.created` ("Make secondary Google calendars, and see,
// create, change, and delete events on them") covers both -- it's the
// exact shape of this feature, which only ever creates and touches its
// own dedicated calendar, never the customer's others. Verified against
// every real endpoint this module calls (calendars.insert, events.list/
// insert/patch/delete): all of them accept it. It's also genuinely
// NON-sensitive per Google Cloud Console's own Data Access page --
// confirmed live, not assumed.
//
// The one gap: calendarList.insert (subscribing the new calendar so it's
// actually visible in the customer's Calendar app/phone -- see
// connect.ts, this is load-bearing, not cosmetic) only accepts the full
// `calendar` scope or `calendar.calendarlist`. The latter is still
// sensitive, so this pair doesn't skip verification review, but it
// replaces one broad, alarming grant ("permanently delete all the
// calendars you can access") with two narrow, self-explanatory ones --
// both a cleaner review and a less scary real consent screen.
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.calendarlist";
// `email` is a "basic" (non-sensitive) scope -- unlike `calendar`, it needs
// no verification review, so adding it doesn't touch the pending review for
// the scope above. Added 2026-08-30 so the connected Google account's email
// can be shown back to the customer ("Connected as ...") instead of just
// "Connected." with no way to tell which account is linked.
const USERINFO_SCOPE = "email";

function getClientConfig() {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }
  return { clientId, clientSecret, redirectUri };
}

/** Whether Google Calendar sync is configured at all in this environment --
 *  same "absent unless configured" pattern as platforms/registry.ts, since
 *  this feature is fully optional and env-gated like every platform adapter. */
export function isGoogleCalendarConfigured(): boolean {
  return getClientConfig() !== null;
}

export function getAuthorizeUrl(state: string): string {
  const config = getClientConfig();
  if (!config) throw new Error("Google Calendar isn't configured on this server");
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: `${CALENDAR_SCOPE} ${USERINFO_SCOPE}`,
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
  if (!config) throw new Error("Google Calendar isn't configured on this server");
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
    throw new Error(json.error_description ?? json.error ?? "Google Calendar token exchange failed");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
  };
}

/** Best-effort only -- called once at connect time purely to label the
 *  connection back to the customer ("Connected as ..."). Never blocks or
 *  fails the actual connect flow if it errors; the connection is still
 *  fully functional without an email, just shown as "Connected." like it
 *  always was before this existed. */
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
  if (!config) throw new Error("Google Calendar isn't configured on this server");
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
    throw new Error(json.error_description ?? json.error ?? "Google Calendar token refresh failed");
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
