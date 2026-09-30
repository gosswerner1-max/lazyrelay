-- Token health for connected social accounts.
--
-- needs_reconnect_at: set when LazyRelay knows the stored connection can no
-- longer be used and only the customer can fix it (token expired and the
-- platform can't refresh it, or the platform permanently rejected the refresh
-- grant). Cleared automatically when the customer reconnects (connect.ts
-- upserts the row) or a refresh later succeeds.
-- needs_reconnect_reason: short human-readable cause, safe to show.
-- reconnect_notified_at: when the customer was emailed about it, so a daily
-- job never emails the same problem twice. Cleared on reconnect.
--
-- Additive and nullable: no backfill, no change to existing reads or RLS.

alter table social_accounts
  add column if not exists needs_reconnect_at timestamptz,
  add column if not exists needs_reconnect_reason text,
  add column if not exists reconnect_notified_at timestamptz;
