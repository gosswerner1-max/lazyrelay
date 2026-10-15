-- RENUMBERED 2026-10-10, was 0007_subscriptions_one_per_account.sql. Two files shared the
-- number 0007 (the other is 0007_post_media_bucket.sql). The Supabase CLI and branches keep
-- only one file per version number, so a database built fresh from this folder silently lacked
-- this constraint. Production already has it (applied by hand when it was written), so this
-- file is written to be a no-op wherever the constraint already exists: the whole body runs only
-- when no unique rule on subscriptions(account_id) is present. Nothing between the old position
-- (0007) and this one reads or writes subscriptions rows from SQL, so running it late is safe.
-- The original text follows, with the delete made deterministic on ties and an existence guard.

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
do $$
begin
  if not exists (
    select 1
    from pg_index i
    where i.indrelid = 'public.subscriptions'::regclass
      and i.indisunique
      and i.indnatts = 1
      and i.indpred is null
      and i.indkey[0] = (
        select a.attnum from pg_attribute a
        where a.attrelid = 'public.subscriptions'::regclass and a.attname = 'account_id'
      )
  ) then
    -- Equal updated_at: keep the larger id, so a tie cannot leave two rows and fail the add below.
    delete from public.subscriptions s
    where exists (
      select 1 from public.subscriptions newer
      where newer.account_id = s.account_id
        and (newer.updated_at > s.updated_at
             or (newer.updated_at = s.updated_at and newer.id > s.id))
    );

    alter table public.subscriptions
      add constraint subscriptions_account_id_unique unique (account_id);
  end if;
end;
$$;
