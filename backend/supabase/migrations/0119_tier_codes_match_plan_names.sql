-- Make the stored tier codes match the public plan names (2026-10-10, Werner approved).
--
--   old code      public plan    new code
--   free          Free           free         (unchanged)
--   pro           Starter        starter
--   business      Pro            pro
--   enterprise    Business       business
--   agency        Agency         agency       (unchanged)
--   agency_plus   Agency Plus    agency_plus  (unchanged)
--
-- DEPLOY TOGETHER WITH THE CODE. The matching backend release (billing/tierResolution.ts, tier.ts and every
-- Record<Tier, ...> table) reads and writes the new codes only. Neither side works alone: old code against new rows
-- (or new code against old rows) misreads every paying customer's plan. Apply this migration and ship the release
-- back to back, then run the billing auditor. See the PR description for the ordering and the verification queries.
--
-- Tables that store a tier code (every column found by grepping all migrations; no function, view, policy or column
-- default references a tier string, so there is nothing else to rewrite):
--   subscriptions.tier           text not null, CHECK subscriptions_tier_check (0001, rewritten by 0006, 0011, 0054)
--   cancellation_feedback.tier   text not null, no CHECK (0022): a snapshot of the tier at cancel time
--
-- The three renames collide with each other (the old code "pro" is the new code "business" minus one step, and the
-- new code "pro" was the old "business"), so each table is rewritten with ONE UPDATE and ONE CASE: every row is
-- evaluated against its original value in the same statement, never in a second pass. Never split this into three
-- UPDATEs: "business -> pro" followed by "pro -> starter" would push every old Pro customer down to Starter.
--
-- Everything runs in a single transaction: if the new CHECK rejects any row, the whole migration rolls back and
-- nothing has changed.

begin;

-- Refuse to run twice. A second run would shift every tier again (new "pro" -> "starter", and so on), which is
-- destructive and silent. The old CHECK still allows 'enterprise'; after this migration the CHECK no longer does.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.subscriptions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%enterprise%'
  ) then
    raise exception 'subscriptions has no CHECK allowing the old tier code ''enterprise'': migration 0119 looks already applied, aborting';
  end if;
end $$;

-- Drop every CHECK on subscriptions that mentions the tier column (normally just subscriptions_tier_check, but do not
-- depend on the name).
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.subscriptions'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '\mtier\M'
  loop
    execute format('alter table public.subscriptions drop constraint %I', c.conname);
  end loop;
end $$;

-- One UPDATE per table, one CASE, no collisions. Rows whose code is unchanged (free, agency, agency_plus) are left
-- out of the UPDATE entirely so their updated_at / row versions are not touched.
update public.subscriptions
set tier = case tier
  when 'pro' then 'starter'
  when 'business' then 'pro'
  when 'enterprise' then 'business'
end
where tier in ('pro', 'business', 'enterprise');

update public.cancellation_feedback
set tier = case tier
  when 'pro' then 'starter'
  when 'business' then 'pro'
  when 'enterprise' then 'business'
end
where tier in ('pro', 'business', 'enterprise');

-- New CHECK, exactly the six public codes. Fails (and rolls everything back) if any row holds anything else.
alter table public.subscriptions add constraint subscriptions_tier_check
  check (tier in ('free', 'starter', 'pro', 'business', 'agency', 'agency_plus'));

commit;

-- ============================================================================================================
-- ROLLBACK (manual; do NOT run unless reverting this migration AND the matching code release together).
-- Same shape in reverse: drop the CHECK, ONE CASE per table, restore the old CHECK. Run it in one transaction.
-- ============================================================================================================
-- begin;
--
-- alter table public.subscriptions drop constraint subscriptions_tier_check;
--
-- update public.subscriptions
-- set tier = case tier
--   when 'business' then 'enterprise'
--   when 'pro' then 'business'
--   when 'starter' then 'pro'
-- end
-- where tier in ('starter', 'pro', 'business');
--
-- update public.cancellation_feedback
-- set tier = case tier
--   when 'business' then 'enterprise'
--   when 'pro' then 'business'
--   when 'starter' then 'pro'
-- end
-- where tier in ('starter', 'pro', 'business');
--
-- alter table public.subscriptions add constraint subscriptions_tier_check
--   check (tier in ('free', 'pro', 'business', 'enterprise', 'agency', 'agency_plus'));
--
-- commit;
