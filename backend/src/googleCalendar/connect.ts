// Connect/disconnect flow for a customer's Google Calendar. Much simpler
// than platforms/connect.ts's flow: there's exactly one "adapter" (no
// platform selection), no multi-account picker (Calendar's OAuth token is
// already scoped to one Google account), and one connection per LazyRelay
// account (migration 0071's unique(account_id)) -- so this is a single
// straight-line exchange, not the general-purpose machinery connect.ts
// needs to serve 15+ platforms.

import { supabase } from "../supabase.js";
import { getAuthorizeUrl as buildAuthorizeUrl, exchangeCode, fetchConnectedEmail, type GoogleTokens } from "./oauthClient.js";
import { startWatchingConnection, stopWatchingConnection } from "./pushNotifications.js";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const DEDICATED_CALENDAR_SUMMARY = "LazyRelay Posts";
const DEDICATED_CALENDAR_DESCRIPTION =
  "Scheduled posts from LazyRelay. Every event here is a real post — move, edit, or delete one and LazyRelay picks up the change. Create a new event here and it lands in LazyRelay as a planned idea for that day, ready for you to pick a platform and time.";

interface GoogleCalendarResource {
  id?: string;
  error?: { message?: string };
}

/** Starts the connect flow: creates a short-lived CSRF state row (mirroring
 *  oauth_states' shape, see migration 0071's header comment for why this is
 *  a separate table) and returns the URL to send the customer to. */
export async function startGoogleCalendarConnect(accountId: string): Promise<{ url: string; stateId: string }> {
  const { data, error } = await supabase
    .from("google_calendar_oauth_states")
    .insert({ account_id: accountId })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("Failed to start Google Calendar connect flow");

  const url = buildAuthorizeUrl(data.id);
  return { url, stateId: data.id };
}

async function createDedicatedCalendar(accessToken: string): Promise<string> {
  const createRes = await fetch(`${CALENDAR_API_BASE}/calendars`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ summary: DEDICATED_CALENDAR_SUMMARY, description: DEDICATED_CALENDAR_DESCRIPTION }),
  });
  const createJson = (await createRes.json().catch(() => ({}))) as GoogleCalendarResource;
  if (!createRes.ok || !createJson.id) {
    throw new Error(createJson.error?.message ?? "Could not create the LazyRelay Posts calendar");
  }

  // Without this, the new calendar exists but is invisible in the
  // customer's own Calendar app/website — calendars.insert creates the
  // resource, calendarList.insert is what actually subscribes the calling
  // user to it so it shows up to be seen (and, on a phone, added).
  const listRes = await fetch(`${CALENDAR_API_BASE}/users/me/calendarList`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: createJson.id }),
  });
  if (!listRes.ok) {
    const listJson = (await listRes.json().catch(() => ({}))) as GoogleCalendarResource;
    throw new Error(listJson.error?.message ?? "Created the calendar but could not subscribe it to your Calendar list");
  }

  return createJson.id;
}

/** Completes the connect flow: validates the CSRF state, exchanges the code,
 *  creates the dedicated calendar, and stores everything. Returns the new
 *  connection's id. */
export async function completeGoogleCalendarConnect(
  state: string,
  code: string,
): Promise<{ connectionId: string; calendarName: string }> {
  const { data: stateRow, error: stateError } = await supabase
    .from("google_calendar_oauth_states")
    .select("account_id, expires_at")
    .eq("id", state)
    .single();
  if (stateError || !stateRow) {
    throw new Error("Invalid or already-used connect link");
  }
  // One-time use either way, success or failure — same as oauth_states.
  await supabase.from("google_calendar_oauth_states").delete().eq("id", state);
  if (new Date(stateRow.expires_at) < new Date()) {
    throw new Error("Connect link expired — please try connecting again");
  }

  const tokens: GoogleTokens = await exchangeCode(code);
  const googleCalendarId = await createDedicatedCalendar(tokens.accessToken);
  const connectedEmail = await fetchConnectedEmail(tokens.accessToken);

  const { data: accessVaultId, error: accessVaultError } = await supabase.rpc("store_social_token", {
    p_token: tokens.accessToken,
  });
  if (accessVaultError) throw accessVaultError;

  let refreshVaultId: string | null = null;
  if (tokens.refreshToken) {
    const { data, error } = await supabase.rpc("store_social_token", { p_token: tokens.refreshToken });
    if (error) throw error;
    refreshVaultId = data;
  }

  const { data: connection, error: insertError } = await supabase
    .from("google_calendar_connections")
    .upsert(
      {
        account_id: stateRow.account_id,
        access_token_vault_id: accessVaultId,
        refresh_token_vault_id: refreshVaultId,
        token_expires_at: tokens.expiresAt,
        google_calendar_id: googleCalendarId,
        connected_email: connectedEmail,
        disconnected_at: null,
      },
      { onConflict: "account_id" },
    )
    .select("id")
    .single();
  if (insertError || !connection) throw insertError ?? new Error("Failed to save the Google Calendar connection");

  // Best-effort -- a failed subscribe never fails the connect itself, the
  // connection just relies on the poller's hourly safety net until the next
  // renewal attempt (or a reconnect) succeeds. See pushNotifications.ts.
  await startWatchingConnection({ id: connection.id, google_calendar_id: googleCalendarId });

  return { connectionId: connection.id, calendarName: DEDICATED_CALENDAR_SUMMARY };
}

/** Disconnects a customer's Google Calendar. Deliberately does NOT delete
 *  the dedicated calendar on Google's side or touch any scheduled_posts
 *  rows — same conservative-deletion principle as the rest of this feature
 *  (see design decision 6 in the plan): disconnecting stops syncing, it
 *  doesn't destroy the customer's calendar or their post history. */
export async function disconnectGoogleCalendar(accountId: string): Promise<void> {
  const { data: connection } = await supabase
    .from("google_calendar_connections")
    .select("id, watch_channel_id, watch_resource_id")
    .eq("account_id", accountId)
    .is("disconnected_at", null)
    .maybeSingle();
  if (connection) {
    // Best-effort, never blocks the actual disconnect below -- see
    // pushNotifications.ts.
    await stopWatchingConnection(connection);
  }

  const { error } = await supabase
    .from("google_calendar_connections")
    .update({ disconnected_at: new Date().toISOString() })
    .eq("account_id", accountId)
    .is("disconnected_at", null);
  if (error) throw error;
}
