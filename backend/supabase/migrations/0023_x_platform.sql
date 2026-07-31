-- Adds "x" as a valid platform value, same pattern as
-- 0021_discord_tumblr_platform.sql. Also adds a nullable pkce_verifier
-- column to oauth_states: X's OAuth 2.0 flow is PKCE-only (no plain
-- client-secret-only exchange), and the verifier generated when building
-- the authorize URL has to survive until the callback exchanges the code —
-- oauth_states is the only per-flow storage that already exists for this.

alter table oauth_states drop constraint oauth_states_platform_check;
alter table oauth_states add constraint oauth_states_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x'));

alter table social_accounts drop constraint social_accounts_platform_check;
alter table social_accounts add constraint social_accounts_platform_check
  check (platform in ('meta', 'tiktok', 'pinterest', 'youtube', 'mastodon', 'bluesky', 'telegram', 'linkedin', 'threads', 'facebook', 'instagram', 'discord', 'tumblr', 'x'));

alter table oauth_states add column pkce_verifier text;
