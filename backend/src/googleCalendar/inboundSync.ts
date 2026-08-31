// Calendar -> LazyRelay sync (Phase 2). The inbound half of the two-way
// sync Phase 1 (outboundSync.ts) only ever did one direction of. Uses the
// Calendar API's syncToken incremental sync -- the design (including the
// 410-fallback and the google_updated_at conflict-resolution comparison)
// was already decided when migrations 0071/0072 shipped alongside Phase 1;
// this file implements against that existing schema, no new migration.
//
// Fan-out design: a brand-new event (one a customer created directly in
// Google Calendar, not one LazyRelay wrote) targets every account in the
// connection's target_social_account_ids. Only the FIRST target's new
// scheduled_posts row keeps the source event's own google_event_id --
// scheduled_posts_google_event_id_idx (migration 0072) is a unique index,
// so no two rows can ever share one. Every other target gets its own row
// with no google_event_id yet, and Phase 1's own outboundSync.ts (already
// called automatically by scheduleOnePost()) creates a fresh, independent
// Calendar event for each of those on its own -- exactly like any other
// multi-platform post created elsewhere in this app. Net effect: one
// calendar event becomes N independent, individually two-way-syncable
// events, not N rows silently sharing one event.

import { supabase } from "../supabase.js";
import { getGoogleAccessToken } from "./tokens.js";
import { calendarEventToPost, type CalendarEventForPost } from "./eventMapper.js";
import { scheduleOnePost, checkFreeTierPostLimit } from "../postCreation.js";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

// Safety valve matching every other poller's MAX_*_PER_RUN convention
// (metricsPoller.ts, mentionsAndDmsPoller.ts) -- in real usage a single
// customer manually editing their calendar will never come close to this,
// it exists purely to bound one run's worst case.
const MAX_EVENTS_PER_CONNECTION_PER_RUN = 250;

export interface GoogleCalendarConnectionRow {
  id: string;
  account_id: string;
  google_calendar_id: string;
  sync_token: string | null;
  target_social_account_ids: string[];
}

interface GoogleEventListResponse {
  items?: CalendarEventForPost[];
  nextPageToken?: string;
  nextSyncToken?: string;
  error?: { code?: number; message?: string };
}

export interface InboundSyncResult {
  eventsCreated: number;
  eventsUpdated: number;
  eventsCancelled: number;
  eventsSkipped: number;
  errors: number;
}

function emptyResult(): InboundSyncResult {
  return { eventsCreated: 0, eventsUpdated: 0, eventsCancelled: 0, eventsSkipped: 0, errors: 0 };
}

/** One page of events.list. Passing syncToken and timeMin together is
 *  invalid per Google's own API — timeMin only applies to a fresh full
 *  sync, never an incremental one. */
async function listEventsPage(
  accessToken: string,
  calendarId: string,
  opts: { syncToken?: string; pageToken?: string },
): Promise<GoogleEventListResponse> {
  const params = new URLSearchParams({ singleEvents: "true" });
  if (opts.pageToken) {
    params.set("pageToken", opts.pageToken);
  } else if (opts.syncToken) {
    params.set("syncToken", opts.syncToken);
  } else {
    // First-ever sync for this connection: only forward-looking events are
    // ever relevant to a scheduler — importing a customer's entire calendar
    // history would be pointless and slow.
    params.set("timeMin", new Date().toISOString());
  }
  const res = await fetch(`${CALENDAR_API_BASE}/calendars/${calendarId}/events?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => ({}))) as GoogleEventListResponse;
  if (!res.ok) {
    return { error: { code: res.status, message: json.error?.message ?? `HTTP ${res.status}` } };
  }
  return json;
}

interface LinkedPostRow {
  id: string;
  account_id: string;
  status: string;
  google_updated_at: string | null;
}

async function findLinkedPost(googleEventId: string): Promise<LinkedPostRow | null> {
  const { data, error } = await supabase
    .from("scheduled_posts")
    .select("id, account_id, status, google_updated_at")
    .eq("google_event_id", googleEventId)
    .maybeSingle();
  if (error) {
    console.error(`[googleCalendar/inboundSync] failed to look up linked post for event ${googleEventId}:`, error.message);
    return null;
  }
  return data;
}

async function handleCancelledEvent(event: CalendarEventForPost, result: InboundSyncResult): Promise<void> {
  const linked = await findLinkedPost(event.id);
  if (!linked) return; // never synced, or already cleaned up — nothing to do
  if (linked.status !== "pending" && linked.status !== "needs_approval") {
    // Already posted (or otherwise final) — Proof-of-Publish history is
    // immutable, an inbound delete never touches it.
    result.eventsSkipped += 1;
    return;
  }
  const { error } = await supabase.from("scheduled_posts").delete().eq("id", linked.id);
  if (error) {
    console.error(`[googleCalendar/inboundSync] failed to delete post ${linked.id} for cancelled event ${event.id}:`, error.message);
    result.errors += 1;
    return;
  }
  result.eventsCancelled += 1;
}

async function handleExistingEvent(event: CalendarEventForPost, linked: LinkedPostRow, result: InboundSyncResult): Promise<void> {
  // Echo check: our own outbound write already recorded the event's
  // `updated` timestamp as google_updated_at at write time. If Google's
  // copy hasn't moved past that, this is that same write reflected back in
  // the incremental sync, not a genuine external edit.
  if (linked.google_updated_at && event.updated && new Date(event.updated).getTime() <= new Date(linked.google_updated_at).getTime()) {
    result.eventsSkipped += 1;
    return;
  }
  if (linked.status !== "pending" && linked.status !== "needs_approval") {
    // A real external edit, but the post is already final — never rewrite
    // Proof-of-Publish history from a calendar change.
    result.eventsSkipped += 1;
    return;
  }
  const mapped = calendarEventToPost(event);
  if (!mapped.content || !mapped.scheduledFor) {
    // A customer cleared the event's content/time entirely — nothing
    // sane to sync; leave the post as it was rather than write garbage.
    result.eventsSkipped += 1;
    return;
  }
  const { error } = await supabase
    .from("scheduled_posts")
    .update({
      content: mapped.content,
      scheduled_for: mapped.scheduledFor,
      google_updated_at: mapped.googleUpdatedAt,
      last_synced_at: new Date().toISOString(),
    })
    .eq("id", linked.id);
  if (error) {
    console.error(`[googleCalendar/inboundSync] failed to update post ${linked.id} from event ${event.id}:`, error.message);
    result.errors += 1;
    return;
  }
  result.eventsUpdated += 1;
}

async function handleNewEvent(
  event: CalendarEventForPost,
  connection: GoogleCalendarConnectionRow,
  result: InboundSyncResult,
): Promise<void> {
  const mapped = calendarEventToPost(event);
  if (!mapped.content || !mapped.scheduledFor) {
    result.eventsSkipped += 1;
    return;
  }
  const targets = connection.target_social_account_ids;
  if (!targets.length) {
    console.warn(`[googleCalendar/inboundSync] connection ${connection.id} has no target_social_account_ids — skipping event ${event.id}`);
    result.eventsSkipped += 1;
    return;
  }

  const [firstTarget, ...remainingTargets] = targets;

  // First target: a direct insert so google_event_id can be set to the
  // SOURCE event's id — scheduleOnePost() never accepts one, since every
  // other caller is creating a post that doesn't have a Calendar event yet.
  const limitError = await checkFreeTierPostLimit(connection.account_id, firstTarget);
  if (limitError) {
    console.warn(`[googleCalendar/inboundSync] free-tier limit reached for account ${firstTarget}, skipping event ${event.id}`);
    result.eventsSkipped += 1;
  } else {
    const { error } = await supabase.from("scheduled_posts").insert({
      account_id: connection.account_id,
      social_account_id: firstTarget,
      content: mapped.content,
      scheduled_for: mapped.scheduledFor,
      status: "needs_approval",
      google_event_id: event.id,
      google_updated_at: mapped.googleUpdatedAt,
      last_synced_at: new Date().toISOString(),
    });
    if (error) {
      console.error(`[googleCalendar/inboundSync] failed to create post for event ${event.id} (account ${firstTarget}):`, error.message);
      result.errors += 1;
    } else {
      result.eventsCreated += 1;
    }
  }

  // Remaining targets: scheduleOnePost() handles validation, the same
  // tier-limit check, the insert, and — because it has no google_event_id
  // to update — its own automatic syncPostToCalendar() call creates a
  // fresh, independent Calendar event for each one. No new sync code
  // needed for this half.
  for (const socialAccountId of remainingTargets) {
    const outcome = await scheduleOnePost(connection.account_id, {
      socialAccountId,
      content: mapped.content,
      scheduledFor: mapped.scheduledFor,
      requiresApproval: true,
    });
    if (outcome.status >= 400) {
      console.warn(
        `[googleCalendar/inboundSync] could not fan out event ${event.id} to account ${socialAccountId}: ${JSON.stringify(outcome.body)}`,
      );
      result.eventsSkipped += 1;
    } else {
      result.eventsCreated += 1;
    }
  }
}

/** Syncs one connection's inbound changes. Never throws — every failure is
 *  logged and counted, matching every other poller's per-item resilience
 *  (a bad event or a transient API error must never take down the rest of
 *  the run, let alone the rest of the connections). */
export async function syncConnectionInbound(connection: GoogleCalendarConnectionRow): Promise<InboundSyncResult> {
  const result = emptyResult();

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(connection.id);
  } catch (err) {
    console.error(`[googleCalendar/inboundSync] could not get access token for connection ${connection.id}:`, err instanceof Error ? err.message : err);
    result.errors += 1;
    return result;
  }

  let syncToken = connection.sync_token ?? undefined;
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let eventsProcessed = 0;
  let hitCap = false;
  let attemptedFullResyncAfter410 = false;

  while (true) {
    const page = await listEventsPage(accessToken, connection.google_calendar_id, { syncToken, pageToken });

    if (page.error) {
      if (page.error.code === 410 && !attemptedFullResyncAfter410) {
        // Token expired/invalid — Google's documented recovery is to drop
        // it and do a fresh full sync (see migration 0071's own comment).
        // Only ever retried once per run, so a persistently-failing
        // connection can't loop forever.
        console.warn(`[googleCalendar/inboundSync] sync token expired for connection ${connection.id}, falling back to full resync`);
        attemptedFullResyncAfter410 = true;
        syncToken = undefined;
        pageToken = undefined;
        continue;
      }
      console.error(`[googleCalendar/inboundSync] events.list failed for connection ${connection.id}: ${page.error.message}`);
      result.errors += 1;
      return result;
    }

    for (const event of page.items ?? []) {
      if (eventsProcessed >= MAX_EVENTS_PER_CONNECTION_PER_RUN) {
        hitCap = true;
        break;
      }
      eventsProcessed += 1;

      try {
        if (event.status === "cancelled") {
          await handleCancelledEvent(event, result);
          continue;
        }
        const linked = await findLinkedPost(event.id);
        if (linked) {
          await handleExistingEvent(event, linked, result);
        } else {
          await handleNewEvent(event, connection, result);
        }
      } catch (err) {
        console.error(`[googleCalendar/inboundSync] unexpected error processing event ${event.id}:`, err instanceof Error ? err.message : err);
        result.errors += 1;
      }
    }

    if (hitCap) break;
    if (!page.nextPageToken) {
      nextSyncToken = page.nextSyncToken;
      break;
    }
    pageToken = page.nextPageToken;
  }

  // Only persist a new token if we actually reached the end of the pages —
  // if we stopped early on the cap, keep the OLD token (still valid) so the
  // next run starts from the same place. Google will hand back the same
  // batch again, which is safe: already-processed events just hit the echo
  // check or the "already final" skip and no-op.
  const updates: Record<string, unknown> = { last_synced_at: new Date().toISOString() };
  if (!hitCap) {
    updates.sync_token = nextSyncToken ?? null;
  }
  const { error: updateError } = await supabase.from("google_calendar_connections").update(updates).eq("id", connection.id);
  if (updateError) {
    console.error(`[googleCalendar/inboundSync] failed to persist sync state for connection ${connection.id}:`, updateError.message);
    result.errors += 1;
  }

  return result;
}
