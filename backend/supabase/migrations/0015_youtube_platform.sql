-- Adds "youtube" as a valid platform value. Found live: the real YouTube
-- PlatformAdapter's connect flow failed with "violates check constraint
-- oauth_states_platform_check" because both oauth_states.platform and
-- social_accounts.platform were still limited to the original three
-- platforms (meta, tiktok, pinterest) from migration 0001/0004.

alter table oauth_states drop constraint oauth_states_platform_check;
alter table oauth_states add constraint oauth_states_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube'));

alter table social_accounts drop constraint social_accounts_platform_check;
alter table social_accounts add constraint social_accounts_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube'));
