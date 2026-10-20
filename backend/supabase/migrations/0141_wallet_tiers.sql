-- 0141: wallet tiers (growth, lazy_pro), the pay as you go unlock column and the multi platform charge group column.
--
-- NOT applied anywhere. Apply by hand with the owner's yes, on a throwaway Supabase branch first. Additive and idempotent: running it
-- twice changes nothing the second time. No row is rewritten.
--
-- What it does.
--   1. subscriptions_tier_check also allows 'growth' and 'lazy_pro', keeping every value 0119 set: free, starter, pro, business, agency,
--      agency_plus. 'lazy_pro' is the new Pro plan; the old 'pro' ($59.99) plan keeps its code and meaning. 'payg' is NOT listed: it is
--      derived by the backend (tier.ts resolveTier) and never stored.
--   2. accounts.payg_unlocked_at: set when the account first pays for pay as you go; null means not unlocked.
--   3. scheduled_posts.charge_group_id: one id shared by the posts of a single multi platform schedule, so the wallet can charge the group
--      once. Partial index, because most rows have none.
--
-- ROLLBACK (manual, only while no row holds 'growth' or 'lazy_pro'):
--   alter table public.subscriptions drop constraint if exists subscriptions_tier_check;
--   alter table public.subscriptions add constraint subscriptions_tier_check
--     check (tier in ('free', 'starter', 'pro', 'business', 'agency', 'agency_plus'));
--   drop index if exists public.scheduled_posts_charge_group_id_idx;
--   alter table public.scheduled_posts drop column if exists charge_group_id;
--   alter table public.accounts drop column if exists payg_unlocked_at;

begin;

alter table public.subscriptions drop constraint if exists subscriptions_tier_check;
alter table public.subscriptions add constraint subscriptions_tier_check
  check (tier in ('free', 'starter', 'pro', 'business', 'agency', 'agency_plus', 'growth', 'lazy_pro'));

alter table public.accounts add column if not exists payg_unlocked_at timestamptz;

alter table public.scheduled_posts add column if not exists charge_group_id uuid;
create index if not exists scheduled_posts_charge_group_id_idx
  on public.scheduled_posts (charge_group_id)
  where charge_group_id is not null;

commit;
