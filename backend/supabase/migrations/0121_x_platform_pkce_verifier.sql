-- RENUMBERED 2026-10-10, was 0023_x_platform.sql. Two files shared the number 0023 (the other is
-- 0023_api_keys.sql). The Supabase CLI and branches keep only one file per version number, so a
-- database built fresh from this folder silently lacked oauth_states.pkce_verifier. Production
-- already has it (applied by hand), so this file is a no-op there (add column if not exists).
--
-- The platform check constraints that the original file rebuilt are deliberately NOT rebuilt
-- here. Since 0023 the same constraints were rebuilt by 0108, 0111, 0113 and 0114, and the list
-- in 0108 already includes 'x'. Running the old 0023 list again now, after 0114, would narrow the
-- check (dropping wordpress, devto, hashnode, lemmy, slack, nostr, whop) and fail on any such
-- row. A fresh build gets 'x' from 0108 and every later platform from its own file, so nothing
-- is lost by leaving the checks to those migrations.
--
-- Original header, kept for history: adds "x" as a valid platform value, same pattern as
-- 0021_discord_tumblr_platform.sql. Also adds a nullable pkce_verifier
-- column to oauth_states: X's OAuth 2.0 flow is PKCE-only (no plain
-- client-secret-only exchange), and the verifier generated when building
-- the authorize URL has to survive until the callback exchanges the code —
-- oauth_states is the only per-flow storage that already exists for this.

alter table oauth_states add column if not exists pkce_verifier text;
