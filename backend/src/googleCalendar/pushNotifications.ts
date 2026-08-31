// Google Calendar push notifications (events.watch) -- Phase 3. Turns
// inboundSync.ts's trigger from "wait for the next hourly poll" into "fire
// the moment Google tells us something changed." The sync LOGIC in
// inboundSync.ts is completely unchanged by this file -- a webhook call is
// just a faster way to invoke the exact same syncConnectionInbound() the
// poller already calls. The poller itself stays on as a safety net (a
// missed webhook delivery, a channel that lapsed between renewal checks).
//
// Google's push notification carries no data, only headers -- a channel id
// and a resource state ("sync" for the one-time handshake, "exists" for a
// real change). Verifying an incoming call is genuinely about a channel we
// created (not a guessed/replayed id) is our own job: we generate a random
// `token` at subscribe time, Google echoes it back on every notification,
// and the webhook route compares it with crypto.timingSafeEqual before
// trusting anything -- same fail-closed spirit as the Paddle webhook
// handler (src/http/webhook.ts), adapted since there's no SDK doing this
// comparison for us here.

import { randomUUID, randomBytes } from "node:crypto";
import { supabase } from "../supabase.js";
import { getGoogleAccessToken } from "./tokens.js";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

// Google's own max/default; requesting anything longer is silently clamped
// to this by the API. Renewal (renewExpiringWatches) runs well before this
// via the existing hourly poller, so the real customer-visible ceiling on
// "how stale can a channel get before it's replaced" is ~24h, not 7 days.
const CHANNEL_TTL_SECONDS = 7 * 24 * 60 * 60;

// Derived from the existing OAuth redirect env var rather than a new one --
// same host, already HTTPS with a valid cert (Render), already the address
// Google's own OAuth flow trusts for this exact backend.
function getWebhookUrl(): string | null {
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!redirectUri) return null;
  return redirectUri.replace(/\/callback$/, "/webhook");
}

interface WatchTargetConnection {
  id: string;
  google_calendar_id: string;
}

interface GoogleWatchResponse {
  resourceId?: string;
  expiration?: string; // ms-epoch, as a string, per Google's API
  error?: { message?: string };
}

/** Subscribes to push notifications for one connection's dedicated
 *  calendar. Best-effort: a failure here never blocks connect or throws out
 *  to the caller -- the connection simply stays on poll-only sync until the
 *  next renewal attempt (or a customer reconnects) succeeds. */
export async function startWatchingConnection(connection: WatchTargetConnection): Promise<void> {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) return; // not configured in this environment -- same "absent unless configured" pattern as the rest of this feature

  const channelId = randomUUID();
  const channelToken = randomBytes(32).toString("hex");

  try {
    const accessToken = await getGoogleAccessToken(connection.id);
    const res = await fetch(`${CALENDAR_API_BASE}/calendars/${connection.google_calendar_id}/events/watch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: webhookUrl,
        token: channelToken,
        params: { ttl: String(CHANNEL_TTL_SECONDS) },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as GoogleWatchResponse;
    if (!res.ok || !json.resourceId) {
      console.warn(`[googleCalendar/pushNotifications] watch failed for connection ${connection.id}: ${json.error?.message ?? res.status}`);
      return;
    }
    const { error } = await supabase
      .from("google_calendar_connections")
      .update({
        watch_channel_id: channelId,
        watch_resource_id: json.resourceId,
        watch_channel_token: channelToken,
        watch_expiration: json.expiration ? new Date(Number(json.expiration)).toISOString() : null,
      })
      .eq("id", connection.id);
    if (error) {
      console.error(`[googleCalendar/pushNotifications] failed to persist watch state for connection ${connection.id}:`, error.message);
    }
  } catch (err) {
    console.warn(`[googleCalendar/pushNotifications] watch error for connection ${connection.id}:`, err instanceof Error ? err.message : err);
  }
}

interface StopTargetConnection {
  id: string;
  watch_channel_id: string | null;
  watch_resource_id: string | null;
}

/** Stops push notifications for one connection, if it has an active watch.
 *  Best-effort and never throws -- same conservative style as
 *  disconnectGoogleCalendar() in connect.ts, which this is meant to run
 *  alongside. Clears the local columns even if Google's own channels.stop
 *  call fails (an expired/already-stopped channel on Google's side is not
 *  something a customer disconnecting should ever be blocked by). */
export async function stopWatchingConnection(connection: StopTargetConnection): Promise<void> {
  if (!connection.watch_channel_id || !connection.watch_resource_id) return;

  try {
    const accessToken = await getGoogleAccessToken(connection.id);
    await fetch(`${CALENDAR_API_BASE}/channels/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: connection.watch_channel_id, resourceId: connection.watch_resource_id }),
    });
  } catch (err) {
    console.warn(`[googleCalendar/pushNotifications] channels.stop error for connection ${connection.id} (continuing anyway):`, err instanceof Error ? err.message : err);
  }

  const { error } = await supabase
    .from("google_calendar_connections")
    .update({ watch_channel_id: null, watch_resource_id: null, watch_channel_token: null, watch_expiration: null })
    .eq("id", connection.id);
  if (error) {
    console.error(`[googleCalendar/pushNotifications] failed to clear watch state for connection ${connection.id}:`, error.message);
  }
}

// Renew anything expiring within this window -- generous relative to the
// poller's hourly cadence so a connection gets several chances to renew
// before it would ever actually lapse.
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Finds every active connection whose watch is missing or expiring soon,
 *  and re-subscribes it. Meant to be called once per poller run, before the
 *  regular sync pass -- reuses the existing hourly cadence rather than a
 *  new scheduled task. Never throws; per-connection failures are logged and
 *  skipped, same as every other poller in this codebase. */
export async function renewExpiringWatches(): Promise<void> {
  const cutoff = new Date(Date.now() + RENEWAL_WINDOW_MS).toISOString();
  const { data: connections, error } = await supabase
    .from("google_calendar_connections")
    .select("id, google_calendar_id, watch_channel_id, watch_resource_id, watch_expiration")
    .is("disconnected_at", null)
    .or(`watch_expiration.is.null,watch_expiration.lt.${cutoff}`);
  if (error) {
    console.error("[googleCalendar/pushNotifications] failed to load connections needing watch renewal:", error.message);
    return;
  }

  for (const connection of connections ?? []) {
    if (connection.watch_channel_id && connection.watch_resource_id) {
      await stopWatchingConnection(connection);
    }
    await startWatchingConnection(connection);
  }
}
