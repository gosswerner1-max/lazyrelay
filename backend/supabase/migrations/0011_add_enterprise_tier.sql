-- Adds the new top-tier ("Business", internally coded "enterprise") to the
-- allowed tier set. Deliberately additive only, unlike 0006's rename —
-- the existing 'pro'/'business' DB values keep their current meaning and
-- rows untouched; only what they DISPLAY as changed (Free/Starter/Pro/
-- Business restructure, 2026-07-23). No existing subscriber data needs to
-- change for this migration to be correct.
alter table subscriptions drop constraint subscriptions_tier_check;
alter table subscriptions add constraint subscriptions_tier_check
  check (tier in ('free', 'pro', 'business', 'enterprise'));
