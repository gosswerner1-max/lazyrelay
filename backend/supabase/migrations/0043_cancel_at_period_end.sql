-- Fixes a real customer-facing mismatch found live 2026-08-11: the cancel
-- confirmation modal promises "you'll keep access until <period end>," but
-- cancelSubscription()/cancelStorageAddon() flipped status to "cancelled"
-- immediately, and resolveTier() treats non-active/trialing status as Free
-- right away -- so a customer lost paid access the instant they clicked
-- cancel, a full billing period earlier than promised. Paddle's own
-- cancellation is now deferred to next_billing_period; this column tracks
-- that locally so status can stay "active" (real paid access continues)
-- until the real subscription.canceled webhook lands at the actual period
-- end, while the UI still shows "Cancelling: ends <date>" in the meantime.
alter table subscriptions add column cancel_at_period_end boolean not null default false;
alter table storage_addons add column cancel_at_period_end boolean not null default false;
