// LazyRelay -> Calendar sync. Called synchronously at the moment of an
// existing mutation (create/update/reschedule/delete a scheduled post) --
// no new poll loop needed for this direction, it's a same-process API call
// added to routes that already exist. Every function here is a deliberate
// no-op (never throws) when the account has no active Google Calendar
// connection, so callers can call these unconditionally without an
// if-connected check at every call site.

import { supabase } from "../supabase.js";
import { getGoogleAccessToken } from "./tokens.js";
import { postToCalendarEvent, type ScheduledPostForCalendar } from "./eventMapper.js";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

interface GoogleCalendarConnectionRow {
  id: string;
  google_calendar_id: string;
}

async function getActiveConnection(accountId: string): Promise<GoogleCalendarConnectionRow | null> {
  const { data, error } = await supabase
    .from("google_calendar_connections")
    .select("id, google_calendar_id")
    .eq("account_id", accountId)
    .is("disconnected_at", null)
    .maybeSingle();
  if (error) {
    console.error("[googleCalendar/outboundSync] failed to load connection:", error.message);
    return null;
  }
  return data;
}

interface GoogleEventResource {
  id?: string;
  updated?: string;
  error?: { message?: string };
}

/** Creates or updates the Calendar event mirroring one scheduled_posts row.
 *  Silently returns if the account has no active connection, the post has
 *  no scheduled_for (a draft), or the Calendar API call fails — a failed
 *  outbound sync must never fail or block the post-scheduling action itself,
 *  same "a comment failure must never fail the parent post" principle
 *  platforms/types.ts already documents for postComment(). */
export async function syncPostToCalendar(scheduledPostId: string): Promise<void> {
  const { data: post, error: postError } = await supabase
    .from("scheduled_posts")
    .select("id, account_id, content, scheduled_for, google_event_id, social_accounts(platform)")
    .eq("id", scheduledPostId)
    .maybeSingle();
  if (postError || !post) {
    if (postError) console.error("[googleCalendar/outboundSync] failed to load post:", postError.message);
    return;
  }

  const connection = await getActiveConnection(post.account_id);
  if (!connection) return;

  // Supabase's PostgREST client types a to-one embed as an array even
  // though the FK guarantees exactly one row here (same quirk scheduler.ts
  // already works around for this exact relation).
  const socialAccount = Array.isArray(post.social_accounts) ? post.social_accounts[0] : post.social_accounts;
  const platformLabel = (socialAccount as { platform?: string } | undefined)?.platform ?? null;
  const eventForCalendar: ScheduledPostForCalendar = {
    id: post.id,
    content: post.content,
    scheduled_for: post.scheduled_for,
    platform_label: platformLabel ? platformLabel[0].toUpperCase() + platformLabel.slice(1) : null,
  };
  const eventBody = postToCalendarEvent(eventForCalendar);
  if (!eventBody) return; // no scheduled_for yet (still a draft) — nothing to sync

  try {
    const accessToken = await getGoogleAccessToken(connection.id);
    const isUpdate = !!post.google_event_id;
    const url = isUpdate
      ? `${CALENDAR_API_BASE}/calendars/${connection.google_calendar_id}/events/${post.google_event_id}`
      : `${CALENDAR_API_BASE}/calendars/${connection.google_calendar_id}/events`;
    const res = await fetch(url, {
      method: isUpdate ? "PATCH" : "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(eventBody),
    });
    const json = (await res.json().catch(() => ({}))) as GoogleEventResource;
    if (!res.ok || !json.id) {
      console.error(`[googleCalendar/outboundSync] event sync failed for post ${scheduledPostId}:`, json.error?.message ?? res.status);
      return;
    }
    await supabase
      .from("scheduled_posts")
      .update({ google_event_id: json.id, google_updated_at: json.updated ?? null, last_synced_at: new Date().toISOString() })
      .eq("id", scheduledPostId);
  } catch (err) {
    console.error(`[googleCalendar/outboundSync] event sync error for post ${scheduledPostId}:`, err instanceof Error ? err.message : err);
  }
}

/** Deletes the Calendar event for a scheduled_posts row that's about to be
 *  (or already was) deleted on our side. Call this BEFORE deleting the row
 *  itself, since it needs the row's google_event_id/account_id. */
export async function deletePostFromCalendar(scheduledPostId: string): Promise<void> {
  const { data: post, error: postError } = await supabase
    .from("scheduled_posts")
    .select("account_id, google_event_id")
    .eq("id", scheduledPostId)
    .maybeSingle();
  if (postError || !post || !post.google_event_id) return;

  const connection = await getActiveConnection(post.account_id);
  if (!connection) return;

  try {
    const accessToken = await getGoogleAccessToken(connection.id);
    const res = await fetch(`${CALENDAR_API_BASE}/calendars/${connection.google_calendar_id}/events/${post.google_event_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // 410 Gone means the event is already deleted on Google's side —
    // that's the goal state, not a failure.
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      console.error(`[googleCalendar/outboundSync] event delete failed for post ${scheduledPostId}: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[googleCalendar/outboundSync] event delete error for post ${scheduledPostId}:`, err instanceof Error ? err.message : err);
  }
}
