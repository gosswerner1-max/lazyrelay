-- Links a scheduled_posts row to its mirrored Google Calendar event, once a
-- customer has a google_calendar_connections row. Nullable throughout --
-- every existing row, and every account that never connects Calendar, is
-- entirely unaffected.

alter table scheduled_posts add column google_event_id text;
-- Google's own last-modified timestamp for the linked event (event.updated
-- from the Calendar API), compared against our own updated_at (migration
-- 0070) for last-write-wins conflict resolution -- see outboundSync.ts /
-- inboundSyncPoller.ts. Distinct from last_synced_at below: this is "when
-- Google says it last changed," that is "when we last reconciled."
alter table scheduled_posts add column google_updated_at timestamptz;
alter table scheduled_posts add column last_synced_at timestamptz;

-- A given Google Calendar event id must map to at most one scheduled_posts
-- row. Partial (non-null only) so the vast majority of rows -- which never
-- touch Calendar sync at all -- pay no index cost and never collide on the
-- shared NULL value.
create unique index scheduled_posts_google_event_id_idx
  on scheduled_posts (google_event_id) where google_event_id is not null;
