-- Two fixes from the Supabase Performance Advisor (checked 2026-09-22):
-- 4 "Auth RLS Initialization Plan" warnings and 23 "Unindexed foreign keys"
-- info suggestions. Deliberately does NOT touch the other two findings from
-- the same report: "Multiple Permissive Policies" (account_members has 3
-- overlapping SELECT policies -- real, but needs actual policy-consolidation
-- design work, not a drop-in fix) and "Unused Index" (25 indexes flagged
-- unused -- almost certainly just this early-stage product's low query
-- volume, not evidence the indexes are wrong; dropping them now would be
-- premature).

-- ============================================================
-- Auth RLS Initialization Plan: these 4 policies call `auth.uid()` inline,
-- which Postgres re-evaluates once PER ROW. Wrapping it as
-- `(select auth.uid())` lets Postgres evaluate it once per statement and
-- reuse the result -- same access rules, cheaper at scale. Standard
-- Supabase-documented fix:
-- https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
--
-- Note: RLS is still defense-in-depth only on this schema -- the backend
-- connects with the service-role key, which bypasses these policies
-- entirely (see 0081_team_aware_rls_policies.sql). This migration changes
-- nothing about live app behavior; it only makes the safety net itself
-- cheaper to evaluate whenever it does run (Advisor checks, direct
-- Postgres access, or a future switch to real enforcement).
-- ============================================================

drop policy if exists account_members_select_own_membership on account_members;
create policy "account_members_select_own_membership" on account_members
  for select using ((select auth.uid()) = user_id);

drop policy if exists account_members_select_as_account_owner on account_members;
create policy "account_members_select_as_account_owner" on account_members
  for select using ((select auth.uid()) = account_id);

drop policy if exists api_keys_insert_owner on api_keys;
create policy "api_keys_insert_owner" on api_keys
  for insert with check (account_id = (select auth.uid()));

drop policy if exists api_keys_delete_owner on api_keys;
create policy "api_keys_delete_owner" on api_keys
  for delete using (account_id = (select auth.uid()));

-- ============================================================
-- Unindexed foreign keys: 23 FK columns with no covering index, which can
-- make joins and cascading deletes through them slow as these tables grow.
-- Plain btree indexes, same pattern as 0066_scaling_indexes.sql. Column
-- names verified against each table's own create-table migration, not
-- assumed from the Advisor's constraint-name convention alone.
-- ============================================================

create index admin_audit_log_target_account_id_idx on admin_audit_log(target_account_id);
create index admin_key_intents_admin_key_id_idx on admin_key_intents(admin_key_id);
create index cancellation_feedback_account_id_idx on cancellation_feedback(account_id);
create index dm_automations_scheduled_post_id_idx on dm_automations(scheduled_post_id);
create index google_calendar_connections_access_token_vault_id_idx on google_calendar_connections(access_token_vault_id);
create index google_calendar_connections_refresh_token_vault_id_idx on google_calendar_connections(refresh_token_vault_id);
create index google_calendar_oauth_states_account_id_idx on google_calendar_oauth_states(account_id);
create index google_sheets_connections_access_token_vault_id_idx on google_sheets_connections(access_token_vault_id);
create index google_sheets_connections_refresh_token_vault_id_idx on google_sheets_connections(refresh_token_vault_id);
create index google_sheets_oauth_states_account_id_idx on google_sheets_oauth_states(account_id);
create index media_uploads_account_id_idx on media_uploads(account_id);
create index mention_comments_cache_social_account_id_idx on mention_comments_cache(social_account_id);
create index oauth_states_account_id_idx on oauth_states(account_id);
create index oauth_states_pending_token_vault_id_idx on oauth_states(pending_token_vault_id);
create index post_metrics_account_id_idx on post_metrics(account_id);
create index post_results_account_id_idx on post_results(account_id);
create index recurring_schedule_targets_social_account_id_idx on recurring_schedule_targets(social_account_id);
create index recurring_schedules_account_id_idx on recurring_schedules(account_id);
create index review_feedback_account_id_idx on review_feedback(account_id);
create index scheduled_posts_social_account_id_idx on scheduled_posts(social_account_id);
create index social_accounts_access_token_vault_id_idx on social_accounts(access_token_vault_id);
create index social_accounts_refresh_token_vault_id_idx on social_accounts(refresh_token_vault_id);
create index storage_addons_account_id_idx on storage_addons(account_id);
