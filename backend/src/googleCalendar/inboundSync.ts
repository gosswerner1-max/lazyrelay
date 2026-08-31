// Calendar -> LazyRelay sync (Phase 2). The inbound half of the two-way
// sync Phase 1 (outboundSync.ts) only ever did one direction of. Uses the
// Calendar API's syncToken incremental sync -- the design (including the
// 410-fallback and the google_updated_at conflict-resolution comparison)
// was already decided when migrations 0071/0072 shipped alongside Phase 1;
// this file implements against that existing schema, no new migration.
//
// New-event design, revised 2026-08-31: a brand-new event (one a customer
// created directly in Google Calendar, not one LazyRelay wrote) has no
// field anywhere for "which platform" -- Calendar just doesn't have one.
// The original design guessed by fanning out to every connected account;
// live-tested the same day and Werner's call was that guessing (even
// reversibly, since every fanned-out row needed approval) was worse than
// not guessing at all. Lands as a `draft` planned-idea row instead --
// content and the calendar day carried over, no account or time
// committed -- using the same status='draft' concept the compose UI's own
// "Add a note or content idea for this day" already has (migration 0049).
// The customer picks the actual platform(s) and time from inside LazyRelay
// itself, the same promote-a-draft flow that already exists for any other
// draft. Still two-way: editing or deleting the event afterward still
// updates or removes the linked draft (see handleExistingEvent/
// handleCancelledEvent below), same as any pending/needs_approval row.

import { supabase } from "../supabase.js";
import { getGoogleAccessToken } from "./tokens.js";
import { calendarEventToPost, type CalendarEventForPost } from "./eventMapper.js";

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

/** Draft/pending/needs_approval are all "not yet posted" — still fair game
 *  for an inbound edit or delete to touch. Everything else (posting,
 *  posted, failed) is final; Proof-of-Publish history is immutable
 *  regardless of what happens on the Calendar side. */
function isStillEditableFromCalendar(status: string): boolean {
  return status === "draft" || status === "pending" || status === "needs_approval";
}

async function handleCancelledEvent(event: CalendarEventForPost, result: InboundSyncResult): Promise<void> {
  const linked = await findLinkedPost(event.id);
  if (!linked) return; // never synced, or already cleaned up — nothing to do
  if (!isStillEditableFromCalendar(linked.status)) {
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
  if (!isStillEditableFromCalendar(linked.status)) {
    // A real external edit, but the post is already final — never rewrite
    // Proof-of-Publish history from a calendar change.
    result.eventsSkipped += 1;
    return;
  }
  const mapped = calendarEventToPost(event);
  if (!mapped.content) {
    // A customer cleared the event's content entirely — nothing sane to
    // sync; leave the post as it was rather than write garbage.
    result.eventsSkipped += 1;
    return;
  }
  // A draft has no committed time (see handleNewEvent) -- an edit updates
  // its planned_date, never invents a scheduled_for it never had. A real
  // pending/needs_approval row keeps updating scheduled_for as before.
  const update: Record<string, unknown> = {
    content: mapped.content,
    google_updated_at: mapped.googleUpdatedAt,
    last_synced_at: new Date().toISOString(),
  };
  if (linked.status === "draft") {
    update.planned_date = mapped.scheduledFor ? mapped.scheduledFor.slice(0, 10) : null;
  } else if (mapped.scheduledFor) {
    update.scheduled_for = mapped.scheduledFor;
  }
  const { error } = await supabase.from("scheduled_posts").update(update).eq("id", linked.id);
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
  if (!mapped.content) {
    result.eventsSkipped += 1;
    return;
  }
  // The calendar day the customer picked, carried over as planned_date —
  // no account or time committed yet, same as any other planned idea
  // (POST /scheduled-posts/draft). No tier-limit check: a draft isn't a
  // real post yet, the existing draft route doesn't check one either.
  const plannedDate = mapped.scheduledFor ? mapped.scheduledFor.slice(0, 10) : null;
  const { error } = await supabase.from("scheduled_posts").insert({
    account_id: connection.account_id,
    social_account_id: null,
    content: mapped.content,
    planned_date: plannedDate,
    status: "draft",
    google_event_id: event.id,
    google_updated_at: mapped.googleUpdatedAt,
    last_synced_at: new Date().toISOString(),
  });
  if (error) {
    console.error(`[googleCalendar/inboundSync] failed to create planned idea for event ${event.id}:`, error.message);
    result.errors += 1;
  } else {
    result.eventsCreated += 1;
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
