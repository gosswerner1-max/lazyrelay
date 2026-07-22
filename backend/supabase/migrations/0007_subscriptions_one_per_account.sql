-- A customer has exactly one subscription row — every read path
-- (GET /subscription, cancelSubscription) already assumes this via
-- .eq("account_id", ...).single()/.maybeSingle(). But the only unique
-- constraint on this table was mor_subscription_id, and Paddle issues a
-- brand-new subscription id on every checkout — so cancelling and
-- re-subscribing (or any repeat upgrade) inserted a second row per account
-- instead of updating the existing one, found live 2026-07-22 while testing
-- the upgrade flow end to end (a cancel + re-upgrade left two rows: one
-- "cancelled", one "active", both real).
--
-- Keep the most-recently-updated row per account, drop the rest, then add
-- the real constraint the application logic already assumed existed.
delete from subscriptions s
where exists (
  select 1 from subscriptions newer
  where newer.account_id = s.account_id
    and newer.updated_at > s.updated_at
);

alter table subscriptions add constraint subscriptions_account_id_unique unique (account_id);
