-- 0124: WhatsApp "bring your own key" (BYOK): the customer's own Meta WhatsApp Business credentials.
--
-- DRAFT for review on branch feature/whatsapp-byok. NOT applied anywhere. Applied by hand with Werner's yes, together
-- with the code that reads these columns.
--
-- Numbering: origin/main ends at 0118. PR #108 reserves 0119 to 0122 and PR #109 (X BYOK) adds 0123, so this stacks on
-- both. Renumber if either changes before this lands.
--
-- Design (same as 0123 for X). The long-lived Meta system user token is NOT given a column of its own. It is stored
-- through store_social_token, in the connection's existing Vault secret (social_accounts.access_token_vault_id), as
-- part of one small JSON login (token plus the two Meta ids). That keeps it behind the same service-role-only RPCs
-- (store_social_token / read_social_token / update_social_token, never executable by anon or authenticated) and, the
-- reason it matters, under the same 0117 wipe: disconnecting or reconnecting overwrites exactly access_token_vault_id
-- and refresh_token_vault_id, so a separate whatsapp_system_user_token_vault_id column would be a secret that
-- survives a disconnect, contradicting what the DPA and the Data Deletion page promise.
--
-- What this migration adds is therefore only non-secret identifiers, which account members can read through RLS like
-- the rest of the row. A WhatsApp Business Account id and a phone number id are identifiers, not credentials: neither
-- can be used without the token. Nothing secret may ever be written to these columns.
--
-- It also does the two things every new platform needs: adds 'whatsapp' to the two platform CHECK constraints (same
-- pattern as 0111, 0113 and 0114), and widens the "BYOK is X-only" constraint from 0123 to X and WhatsApp.

alter table oauth_states drop constraint oauth_states_platform_check;
alter table oauth_states add constraint oauth_states_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x', 'wordpress', 'devto', 'hashnode', 'lemmy', 'slack', 'nostr', 'whop', 'whatsapp'));

alter table social_accounts drop constraint social_accounts_platform_check;
alter table social_accounts add constraint social_accounts_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x', 'wordpress', 'devto', 'hashnode', 'lemmy', 'slack', 'nostr', 'whop', 'whatsapp'));

alter table social_accounts
  add column if not exists whatsapp_business_account_id text,
  add column if not exists whatsapp_phone_number_id text;

do $$
begin
  -- Meta ids are numeric strings. The pattern is a guard against anything else being stored here (a token pasted
  -- into the wrong field would not pass it), not a claim about Meta's exact length.
  if not exists (select 1 from pg_constraint where conname = 'social_accounts_whatsapp_ids_format_check') then
    alter table social_accounts
      add constraint social_accounts_whatsapp_ids_format_check
      check (
        (whatsapp_business_account_id is null or whatsapp_business_account_id ~ '^[0-9]{5,25}$')
        and (whatsapp_phone_number_id is null or whatsapp_phone_number_id ~ '^[0-9]{5,25}$')
      );
  end if;

  -- A WhatsApp row always has both ids and always uses the customer's own credentials; every other platform has
  -- neither id. No existing row can violate this: there is no whatsapp row yet.
  if not exists (select 1 from pg_constraint where conname = 'social_accounts_whatsapp_shape_check') then
    alter table social_accounts
      add constraint social_accounts_whatsapp_shape_check
      check (
        (platform = 'whatsapp' and credential_mode = 'byok'
          and whatsapp_business_account_id is not null and whatsapp_phone_number_id is not null)
        or (platform <> 'whatsapp'
          and whatsapp_business_account_id is null and whatsapp_phone_number_id is null)
      );
  end if;

  -- 0123 said "BYOK is X-only for now. Widen this check if another platform ever gets BYOK." This is that widening.
  alter table social_accounts drop constraint if exists social_accounts_byok_x_only_check;
  if not exists (select 1 from pg_constraint where conname = 'social_accounts_byok_platform_check') then
    alter table social_accounts
      add constraint social_accounts_byok_platform_check
      check (credential_mode = 'platform' or platform in ('x', 'whatsapp'));
  end if;
end $$;

-- ROLLBACK (manual, in one transaction; only safe while no whatsapp row exists, delete those first):
--   alter table social_accounts
--     drop constraint if exists social_accounts_byok_platform_check,
--     drop constraint if exists social_accounts_whatsapp_shape_check,
--     drop constraint if exists social_accounts_whatsapp_ids_format_check,
--     drop column if exists whatsapp_phone_number_id,
--     drop column if exists whatsapp_business_account_id;
--   alter table social_accounts add constraint social_accounts_byok_x_only_check
--     check (credential_mode = 'platform' or platform = 'x');
--   (then put the two platform CHECK constraints back to the list in 0114, without 'whatsapp')
