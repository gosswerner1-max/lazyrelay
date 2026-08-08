-- Multi-brand support at the entry tier (2026-08-08) — item 8 from the
-- 2026-08-07 competitor audit's "my own ideas" list. Deliberately NOT a
-- multi-tenant rearchitecture (separate billing/workspaces per brand, the
-- way Metricool/SocialBee charge) — one login, one subscription, same as
-- today. A customer running several small businesses through one account
-- just labels each connected account with a brand name and can then filter
-- every relevant view (Overview, Posts, Calendar, Mentions, DMs, Analytics)
-- down to one brand at a time. Nullable, no default: an unlabeled account
-- simply shows under "Unbranded" in the filter until the customer labels it.
alter table social_accounts add column brand_label text;
