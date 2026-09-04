-- Fixes a real bug in 0081, found the same day by the new security-test.ts
-- team-access checks: every policy added in 0081 (including account_members'
-- own new "select_team" policy) checks membership via a subquery against
-- account_members itself. For account_members' OWN policy that's genuinely
-- self-referential -- Postgres must apply RLS to the subquery's own read of
-- account_members, which re-triggers the same policy, which subqueries
-- account_members again, forever: "infinite recursion detected in policy
-- for relation account_members". And because every other 0081 policy also
-- depends on reading account_members to check membership, the recursion
-- wasn't contained to account_members' own table -- it broke scheduled_posts,
-- social_accounts, brands, and everything else that depends on the same
-- membership check, the moment any of them tried to evaluate it.
--
-- Standard, well-known fix for exactly this shape (a table whose own RLS
-- policy needs to query itself): a SECURITY DEFINER function. Marked
-- security definer, it runs with the function owner's privileges
-- internally, which bypasses RLS for its own internal query -- breaking
-- the cycle without opening up account_members itself. `stable` (not
-- `volatile`) since it only reads, letting Postgres cache/inline it
-- within one statement rather than re-evaluating per row unnecessarily.
create or replace function is_account_member(target_account_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from account_members
    where account_id = target_account_id
      and user_id = auth.uid()
      and accepted_at is not null
  );
$$;

revoke all on function is_account_member(uuid) from public;
grant execute on function is_account_member(uuid) to authenticated;

-- Rewrite every 0081 policy to call the function instead of inlining the
-- subquery -- not just account_members' own (which was the only one
-- ACTUALLY self-referential), but all of them, so the same pattern is
-- used consistently everywhere and no other table has to discover this
-- recursion risk the hard way later.

drop policy if exists scheduled_posts_select_members on scheduled_posts;
drop policy if exists scheduled_posts_insert_members on scheduled_posts;
drop policy if exists scheduled_posts_update_members on scheduled_posts;
drop policy if exists scheduled_posts_delete_members on scheduled_posts;
create policy "scheduled_posts_select_members" on scheduled_posts for select using (is_account_member(account_id));
create policy "scheduled_posts_insert_members" on scheduled_posts for insert with check (is_account_member(account_id));
create policy "scheduled_posts_update_members" on scheduled_posts for update using (is_account_member(account_id)) with check (is_account_member(account_id));
create policy "scheduled_posts_delete_members" on scheduled_posts for delete using (is_account_member(account_id) and status = 'pending');

drop policy if exists social_accounts_select_members on social_accounts;
drop policy if exists social_accounts_insert_members on social_accounts;
drop policy if exists social_accounts_update_members on social_accounts;
drop policy if exists social_accounts_delete_members on social_accounts;
create policy "social_accounts_select_members" on social_accounts for select using (is_account_member(account_id));
create policy "social_accounts_insert_members" on social_accounts for insert with check (is_account_member(account_id));
create policy "social_accounts_update_members" on social_accounts for update using (is_account_member(account_id)) with check (is_account_member(account_id));
create policy "social_accounts_delete_members" on social_accounts for delete using (is_account_member(account_id));

drop policy if exists accounts_select_members on accounts;
create policy "accounts_select_members" on accounts for select using (is_account_member(id));

drop policy if exists subscriptions_select_members on subscriptions;
create policy "subscriptions_select_members" on subscriptions for select using (is_account_member(account_id));

drop policy if exists post_results_select_members on post_results;
create policy "post_results_select_members" on post_results for select using (is_account_member(account_id));

drop policy if exists post_metrics_select_members on post_metrics;
create policy "post_metrics_select_members" on post_metrics for select using (is_account_member(account_id));

drop policy if exists audience_snapshots_select_members on audience_snapshots;
create policy "audience_snapshots_select_members" on audience_snapshots for select using (is_account_member(account_id));

drop policy if exists recurring_schedules_all_members on recurring_schedules;
create policy "recurring_schedules_all_members" on recurring_schedules for all using (is_account_member(account_id)) with check (is_account_member(account_id));

drop policy if exists recurring_schedule_targets_all_members on recurring_schedule_targets;
create policy "recurring_schedule_targets_all_members" on recurring_schedule_targets
  for all using (
    exists (select 1 from recurring_schedules rs where rs.id = recurring_schedule_targets.recurring_schedule_id and is_account_member(rs.account_id))
  )
  with check (
    exists (select 1 from recurring_schedules rs where rs.id = recurring_schedule_targets.recurring_schedule_id and is_account_member(rs.account_id))
  );

drop policy if exists google_calendar_connections_all_members on google_calendar_connections;
create policy "google_calendar_connections_all_members" on google_calendar_connections for all using (is_account_member(account_id)) with check (is_account_member(account_id));

drop policy if exists google_sheets_connections_all_members on google_sheets_connections;
create policy "google_sheets_connections_all_members" on google_sheets_connections for all using (is_account_member(account_id)) with check (is_account_member(account_id));

drop policy if exists brands_all_members on brands;
create policy "brands_all_members" on brands for all using (is_account_member(account_id)) with check (is_account_member(account_id));

drop policy if exists dm_automations_all_members on dm_automations;
create policy "dm_automations_all_members" on dm_automations for all using (is_account_member(account_id)) with check (is_account_member(account_id));

drop policy if exists dm_automation_log_select_members on dm_automation_log;
create policy "dm_automation_log_select_members" on dm_automation_log
  for select using (
    exists (select 1 from dm_automations da where da.id = dm_automation_log.automation_id and is_account_member(da.account_id))
  );

drop policy if exists comment_triage_select_members on comment_triage;
create policy "comment_triage_select_members" on comment_triage for select using (is_account_member(account_id));

drop policy if exists api_keys_select_members on api_keys;
create policy "api_keys_select_members" on api_keys for select using (is_account_member(account_id));
-- api_keys_insert_owner / api_keys_delete_owner untouched -- those check
-- `account_id = auth.uid()` directly (owner-only, deliberate), never
-- queried account_members at all, so they were never part of the
-- recursion and don't need the function.

-- account_members' own SELECT policy -- the one that was ACTUALLY
-- self-referential. This is the fix that matters most: the function's
-- security definer bypasses RLS for its own internal read of
-- account_members, so this no longer recurses into itself.
drop policy if exists account_members_select_team on account_members;
create policy "account_members_select_team" on account_members for select using (is_account_member(account_id));
