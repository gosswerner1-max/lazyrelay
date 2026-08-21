-- Closes the gap flagged during the 2026-08-21 launch-readiness pass: no
-- welcome email or onboarding-nudge email exists anywhere in the backend.
-- welcome_email_sent_at: makes the send idempotent (one welcome email ever,
--   sent once the new poller finds the account for the first time).
-- onboarding_nudge_sent_at: separate, later, direct-to-customer nudge for
--   accounts that still have zero connected accounts a few days in -- NOT
--   the same as the existing findStuckOnboardingAccounts() in
--   accounts_ops.js, which is an internal 7-day alert routed to Werner for
--   manual outreach, unchanged by this migration. This one sends the
--   customer their own email automatically, same auto-send pattern already
--   live for the data-retention reminder (data_retention_ops.js).
--
-- Backfilled to now() for every existing row so real accounts (and any
-- other pre-existing signups) don't get a stray retroactive welcome email
-- the moment this ships.
alter table accounts add column welcome_email_sent_at timestamptz;
alter table accounts add column onboarding_nudge_sent_at timestamptz;

update accounts set welcome_email_sent_at = now(), onboarding_nudge_sent_at = now();
