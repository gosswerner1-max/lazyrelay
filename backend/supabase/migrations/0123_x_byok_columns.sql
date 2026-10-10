-- 0123: X "bring your own key" (BYOK) markers on social_accounts.
--
-- DRAFT for review on branch feature/x-byok. NOT applied anywhere. Applied by hand
-- with Werner's yes, together with the code that reads these columns.
--
-- Numbering: origin/main ends at 0118. PR #108 reserves 0119 to 0122. Renumber if
-- #108 changes before this lands.
--
-- Design: a BYOK X connection keeps all four OAuth 1.0a values (API key, API secret,
-- access token, access token secret) as ONE JSON string in the connection's existing
-- Vault secret (social_accounts.access_token_vault_id), stored through
-- store_social_token. So the secrets get the same protection, the same service-role-only
-- RPCs and the same 0117 wipe on disconnect as every other platform token. This
-- migration therefore adds NO secret column, only non-secret markers the app needs to
-- decide how to treat the account (per-account circuit breaker, UI status, key hint).
--
-- Every column is readable by account members through RLS, like the rest of the row, so
-- nothing secret may ever be written here. The hint is a short masked suffix of the
-- public API key only.

alter table social_accounts
  add column if not exists credential_mode text not null default 'platform',
  add column if not exists byok_status text,
  add column if not exists byok_validated_at timestamptz,
  add column if not exists byok_key_hint text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'social_accounts_credential_mode_check'
  ) then
    alter table social_accounts
      add constraint social_accounts_credential_mode_check
      check (credential_mode in ('platform', 'byok'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'social_accounts_byok_status_check'
  ) then
    alter table social_accounts
      add constraint social_accounts_byok_status_check
      check (byok_status is null or byok_status in ('valid', 'invalid', 'out_of_credit'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'social_accounts_byok_key_hint_check'
  ) then
    alter table social_accounts
      add constraint social_accounts_byok_key_hint_check
      check (byok_key_hint is null or length(byok_key_hint) <= 8);
  end if;

  -- BYOK is X-only for now. Widen this check if another platform ever gets BYOK.
  if not exists (
    select 1 from pg_constraint where conname = 'social_accounts_byok_x_only_check'
  ) then
    alter table social_accounts
      add constraint social_accounts_byok_x_only_check
      check (credential_mode = 'platform' or platform = 'x');
  end if;
end $$;

-- ROLLBACK (manual, in one transaction):
--   alter table social_accounts
--     drop constraint if exists social_accounts_byok_x_only_check,
--     drop constraint if exists social_accounts_byok_key_hint_check,
--     drop constraint if exists social_accounts_byok_status_check,
--     drop constraint if exists social_accounts_credential_mode_check,
--     drop column if exists byok_key_hint,
--     drop column if exists byok_validated_at,
--     drop column if exists byok_status,
--     drop column if exists credential_mode;
