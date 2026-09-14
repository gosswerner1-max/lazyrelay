-- SECURITY FIX (2026-09-14): storage_addons/brand_addons/seat_addons had
-- no out-of-order-webhook guard at all -- unlike subscriptions, which
-- already tracks last_webhook_occurred_at and conditions every update on
-- it (see that table's own migration history and sync.ts). Paddle does
-- not guarantee in-order delivery and this app has a confirmed history of
-- delayed/backlogged deliveries (migration 0067), so a delayed "active"
-- event arriving after a newer "cancelled" event for the same add-on
-- could silently revert its status back to active -- real drift, the
-- exact class of bug syncSubscriptionFromWebhook's own doc comment says
-- must never happen ("this table... must never silently drift from
-- reality"). Doesn't affect the cancellation/data-deletion clock (that's
-- keyed off the tier subscription only), only add-on entitlement
-- display/enforcement correctness.
alter table storage_addons add column last_webhook_occurred_at timestamptz;
alter table brand_addons add column last_webhook_occurred_at timestamptz;
alter table seat_addons add column last_webhook_occurred_at timestamptz;
