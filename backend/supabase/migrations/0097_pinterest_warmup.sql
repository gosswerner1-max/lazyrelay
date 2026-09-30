-- Pinterest warm-up ramp.
--
-- Pinterest treats a new account that posts a lot as spam and can block it, so
-- a NEW Pinterest connection is eased in (see platformPostLimits.ts): 1 pin a
-- day for the first week, then 2, then 3, then the normal daily cap.
--
-- pinterest_warmup_confirmed_at: set when the customer tells us at connect time
-- that the account is already warmed up (they posted by hand first, as the
-- connect popup advises). A confirmed account skips the ramp.
--
-- Every Pinterest connection that exists today is grandfathered as confirmed,
-- so nothing changes for accounts already in use. Additive and nullable.

alter table social_accounts
  add column if not exists pinterest_warmup_confirmed_at timestamptz;

update social_accounts
   set pinterest_warmup_confirmed_at = connected_at
 where platform = 'pinterest'
   and pinterest_warmup_confirmed_at is null;
