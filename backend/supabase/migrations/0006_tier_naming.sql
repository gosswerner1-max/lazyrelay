-- Rename subscription tiers from solo/pro/agency to free/pro/business to
-- match the real, locked pricing decision (see
-- memory/lazyrelay/project-launch-pricing-tiers.md). No real subscriber
-- data exists yet (product is free/testing), so this is a safe rename,
-- not a backfill migration.

alter table subscriptions drop constraint subscriptions_tier_check;

update subscriptions set tier = 'free' where tier = 'solo';
update subscriptions set tier = 'business' where tier = 'agency';

alter table subscriptions add constraint subscriptions_tier_check
  check (tier in ('free', 'pro', 'business'));
