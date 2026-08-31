// Google Calendar inbound sync — the polling half. Not a server process;
// run periodically by an external scheduled task, same pattern as
// metricsPoller.ts and mentionsAndDmsPoller.ts. Pulls in whatever a
// customer changed directly in their "LazyRelay Posts" Google Calendar
// (create/edit/delete an event) via the Calendar API's incremental
// (syncToken) sync — see googleCalendar/inboundSync.ts for the actual
// per-connection logic and the design reasoning.
import "dotenv/config";
import { supabase } from "./supabase.js";
import { syncConnectionInbound, type GoogleCalendarConnectionRow, type InboundSyncResult } from "./googleCalendar/inboundSync.js";
import { renewExpiringWatches } from "./googleCalendar/pushNotifications.js";

// Same bounding convention as every other poller (metricsPoller.ts's
// MAX_POLLS_PER_RUN, mentionsAndDmsPoller.ts's per-category caps) — real
// usage will have a small number of connections, this is a worst-case
// safety valve, not an expected ceiling.
const MAX_CONNECTIONS_PER_RUN = 100;

async function main() {
  // Phase 3: real-time push notifications (pushNotifications.ts) are now
  // the primary trigger for inbound sync -- this poll run is the safety
  // net. Renewing anything expiring soon here reuses this task's existing
  // hourly cadence rather than needing its own scheduled task.
  await renewExpiringWatches();

  const { data: connections, error } = await supabase
    .from("google_calendar_connections")
    .select("id, account_id, google_calendar_id, sync_token, target_social_account_ids")
    .is("disconnected_at", null)
    .limit(MAX_CONNECTIONS_PER_RUN);
  if (error) {
    console.error("googleCalendarInboundPoller: failed to load connections:", error.message);
    process.exit(1);
  }

  const totals: InboundSyncResult = { eventsCreated: 0, eventsUpdated: 0, eventsCancelled: 0, eventsSkipped: 0, errors: 0 };
  let connectionsSynced = 0;

  for (const connection of (connections ?? []) as GoogleCalendarConnectionRow[]) {
    const result = await syncConnectionInbound(connection);
    connectionsSynced += 1;
    totals.eventsCreated += result.eventsCreated;
    totals.eventsUpdated += result.eventsUpdated;
    totals.eventsCancelled += result.eventsCancelled;
    totals.eventsSkipped += result.eventsSkipped;
    totals.errors += result.errors;
  }

  console.log(
    `googleCalendarInboundPoller: ${connectionsSynced} connections synced, ` +
      `${totals.eventsCreated} posts created, ${totals.eventsUpdated} posts updated, ` +
      `${totals.eventsCancelled} posts cancelled, ${totals.eventsSkipped} events skipped, ${totals.errors} errors.`,
  );
}

main().catch((err) => {
  console.error("googleCalendarInboundPoller: unhandled error:", err);
  process.exit(1);
});
