-- MFA recovery codes (2026-08-26) -- Supabase's built-in TOTP MFA (shipped
-- earlier tonight, commit f9118f4) has no backup-code mechanism of its own:
-- lose your authenticator app and you're permanently locked out at the
-- MfaChallenge screen with no way back in. This table backs the missing
-- piece -- 10 single-use codes generated on enrollment/regeneration,
-- redeemable at the challenge screen to remove the lost TOTP factor and let
-- the customer sign back in and re-enroll. See backend/src/http/mfaRecovery.ts.
--
-- Service-role only -- same RLS-enabled-no-policies convention as
-- admin_api_keys/admin_audit_log (0035_admin_api_keys.sql): only the
-- backend's service-role client ever touches this table, never a customer's
-- own browser session, so there's no policy to write.
create table mfa_recovery_codes (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index mfa_recovery_codes_user_id_idx on mfa_recovery_codes (user_id);

alter table mfa_recovery_codes enable row level security;
