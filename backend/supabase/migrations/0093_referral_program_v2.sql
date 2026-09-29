-- Referral/partner program v2 (2026-09-29) -- Werner's design after real
-- competitor benchmarking found the original flat 30% LIFETIME commission
-- (migration 0079) was a real outlier: every direct competitor either pays
-- a lower rate (SocialBee, 20%) or caps the recurring window (~12 months,
-- Buffer/Later) -- nobody combines a top-tier rate with zero time limit.
-- Table confirmed EMPTY live before writing this -- no real partners exist
-- yet, so the old flat commission_rate column is replaced outright rather
-- than migrated.
--
-- Partners now pick one of two structures when Werner adds them:
--   Option A ("gives a viewer discount"): the partner's own code is ALSO a
--     real Paddle discount -- their referred customers get 10% off their
--     first 3 months, the partner earns a flat 20% for the first 12 months.
--   Option B ("keeps it for themselves"): no viewer discount at all -- the
--     partner earns more instead, front-loaded: 30% for the first 3 months,
--     then 20% for months 4-12.
-- Both cap at 12 months total (replacing the old open-ended lifetime).
alter table referral_partners drop column commission_rate;
alter table referral_partners add column gives_viewer_discount boolean not null default true;
alter table referral_partners add column commission_rate_months_1_3 numeric not null default 20;
alter table referral_partners add column commission_rate_months_4_12 numeric not null default 20;

-- Which partner code was actually redeemed AT CHECKOUT, and when -- the
-- 12-month commission window is measured from here. Deliberately separate
-- from the older referred_by_code/referred_at columns (migration 0079),
-- which capture a DIFFERENT moment (signup, via ?ref=, independent of
-- whether the customer ever actually pays) -- those are left untouched.
-- This is checkout-time attribution, tied to a real Paddle-verified
-- redemption (Option A) or an explicit referral link click carried through
-- to checkout (Option B), not just a signup-time URL click.
alter table accounts add column partner_code_redeemed text references referral_partners(code) on delete set null;
alter table accounts add column partner_code_redeemed_at timestamptz;

create index accounts_partner_code_redeemed_idx on accounts(partner_code_redeemed) where partner_code_redeemed is not null;
