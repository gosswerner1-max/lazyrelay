-- Real gap found in the 2026-08-25 pre-launch scalability audit.
--
-- post_results had zero indexes beyond its primary key. Nearly every
-- dashboard/history/analytics call joins it to scheduled_posts via
-- scheduled_post_id (routes.ts), and metricsPoller.ts filters it on
-- verified_live + verification_checked_at every run -- both sequential
-- scans today, fine at ~1 account's history, a real slowdown once
-- post_results grows into the thousands of rows across real customers.
create index post_results_scheduled_post_id_idx on post_results(scheduled_post_id);
create index post_results_verified_checked_idx on post_results(verified_live, verification_checked_at) where verified_live = true;

-- scheduled_posts' only index (0001_init_schema.sql) is the partial
-- scheduled_posts_pending_idx on (scheduled_for) where status='pending' --
-- built for the scheduler's own claim query. Every customer-facing list/
-- history/calendar/analytics route filters by account_id (+ status,
-- ordered by scheduled_for) instead, which that index doesn't cover, and
-- no other index/FK auto-indexes account_id on this table. Same story as
-- post_results above: invisible at 1 account, a real full-table-scan
-- problem once total rows (across all customers, all statuses, all
-- history) grow into the thousands.
create index scheduled_posts_account_status_idx on scheduled_posts(account_id, status, scheduled_for);
