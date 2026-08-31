-- Phase 3: real-time inbound sync via Google Calendar push notifications
-- (events.watch), replacing the hourly poll as the primary trigger for
-- inboundSync.ts -- the poll itself is untouched and stays on as a safety
-- net (a missed webhook, a lapsed channel between renewal checks). All four
-- columns nullable and additive, same graceful-degradation pattern as
-- 0075's connected_email -- a connection with no active watch (never
-- subscribed yet, or a subscribe attempt failed) just falls back to the
-- poll-only behavior it already had, nothing breaks.
alter table google_calendar_connections
  add column watch_channel_id uuid,
  add column watch_resource_id text,
  -- Random secret we generate and send as the channel's `token` at
  -- subscribe time; Google echoes it back as X-Goog-Channel-Token on every
  -- notification. Compared against this stored value (timingSafeEqual) to
  -- confirm an incoming webhook call is genuinely about a channel we
  -- created, not a guessed/replayed channel id.
  add column watch_channel_token text,
  add column watch_expiration timestamptz;

-- Looked up by channel id on every incoming webhook call (pushNotifications.ts).
create unique index google_calendar_connections_watch_channel_id_idx
  on google_calendar_connections (watch_channel_id)
  where watch_channel_id is not null;
