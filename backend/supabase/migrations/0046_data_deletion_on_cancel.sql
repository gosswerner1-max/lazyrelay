-- Real policy change 2026-08-15: unlike every other resource in this app
-- (storage_addons never delete files on their own cancellation, accounts over
-- quota get paused not deleted -- see storageQuota.ts and accounts_ops.js), a
-- customer's posts and uploaded media now DO get deleted after they cancel,
-- following a 30-day grace period counted from accounts.cancelled_at (the
-- real subscription.canceled webhook landing, i.e. the moment they actually
-- stop being a paying customer -- not the moment they click cancel, since
-- cancel_at_period_end already keeps them paid-active until period end).
--
-- data_deletion_ack_at: set the moment the customer ticks the cancel modal's
--   checkbox and confirms -- proof they were told, independent of and earlier
--   than cancelled_at (which only lands later, when Paddle's deferred
--   cancellation actually takes effect).
-- data_deletion_reminder_sent_at: makes the day-23 reminder email idempotent.
-- data_deleted_at: makes the daily reaper job idempotent, and is the audit
--   record that deletion actually happened for this account.
--
-- All three get cleared (except data_deleted_at, a permanent historical fact)
-- if the customer resubscribes before deletion runs -- see the 'active'
-- branch of syncSubscriptionFromWebhook in sync.ts. Without that, a customer
-- who cancels then resubscribes within the 30 days would still have their
-- data silently deleted by the reaper job on schedule.
alter table accounts add column data_deletion_ack_at timestamptz;
alter table accounts add column data_deletion_reminder_sent_at timestamptz;
alter table accounts add column data_deleted_at timestamptz;
