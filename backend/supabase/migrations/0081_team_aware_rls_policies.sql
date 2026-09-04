-- Makes RLS actually correct, ahead of a rework that makes RLS actually
-- enforced (it currently isn't -- the backend only ever connects with the
-- service-role key, which bypasses RLS entirely). This migration alone
-- changes NOTHING about how the live app behaves today, since service-role
-- still bypasses every policy here -- it's purely fixing latent bugs in
-- the safety net itself before it's ever switched on. Two real bugs found
-- by a full audit of all 82 prior migrations' policy history:
--
-- 1. Every policy ever written checks `auth.uid() = account_id` directly.
--    `account_members` (team seats -- 0053) was added 27 migrations after
--    the first policies, and no policy anywhere was ever rewritten for it
--    -- 0053's own comment says as much ("defense-in-depth only... the
--    live enforcement path is the Express backend on the service-role
--    key"). If RLS were ever switched on unmodified, every invited team
--    member would be locked out of every table, owner included on some
--    (accounts_select_own checks `auth.uid() = id`, which by definition
--    can never match a non-owner teammate's uid).
-- 2. Five tables have RLS enabled with ZERO policies ever written --
--    brands (0047), api_keys (0023), dm_automations/dm_automation_log
--    (0036), comment_triage (0040). Under real enforcement these are total
--    lockouts, not narrow bugs. scheduled_posts and social_accounts also
--    have no UPDATE policy at all, ever -- approving/editing/pausing a
--    post or connection would silently affect 0 rows.
--
-- Every policy below uses this predicate consistently for "any accepted
-- member of this account, owner or teammate":
--   account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null)
-- account_members' own INSERT/UPDATE/DELETE deliberately still has no
-- policy here -- invite/accept/remove has seat-limit business logic
-- (seatLimits.ts) that belongs behind a backend/RPC boundary, not raw RLS.
-- accounts' UPDATE policy was deliberately dropped in 0069 ("this policy
-- was never load-bearing... the backend already writes to accounts
-- exclusively via its service-role key") -- correct and unchanged here,
-- only accounts' SELECT gets fixed below.

-- ============================================================
-- Tables with existing owner-only policies -> made team-aware
-- ============================================================

drop policy if exists scheduled_posts_select_own on scheduled_posts;
drop policy if exists scheduled_posts_insert_own on scheduled_posts;
drop policy if exists scheduled_posts_delete_own on scheduled_posts;

create policy "scheduled_posts_select_members" on scheduled_posts
  for select using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));
create policy "scheduled_posts_insert_members" on scheduled_posts
  for insert with check (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));
create policy "scheduled_posts_update_members" on scheduled_posts
  for update using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null))
  with check (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));
create policy "scheduled_posts_delete_members" on scheduled_posts
  for delete using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null) and status = 'pending');

drop policy if exists social_accounts_select_own on social_accounts;
drop policy if exists social_accounts_insert_own on social_accounts;
drop policy if exists social_accounts_delete_own on social_accounts;

create policy "social_accounts_select_members" on social_accounts
  for select using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));
create policy "social_accounts_insert_members" on social_accounts
  for insert with check (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));
create policy "social_accounts_update_members" on social_accounts
  for update using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null))
  with check (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));
create policy "social_accounts_delete_members" on social_accounts
  for delete using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

drop policy if exists accounts_select_own on accounts;
create policy "accounts_select_members" on accounts
  for select using (id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

drop policy if exists subscriptions_select_own on subscriptions;
create policy "subscriptions_select_members" on subscriptions
  for select using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

drop policy if exists post_results_select_own on post_results;
create policy "post_results_select_members" on post_results
  for select using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

drop policy if exists post_metrics_select_own on post_metrics;
create policy "post_metrics_select_members" on post_metrics
  for select using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

drop policy if exists audience_snapshots_select_own on audience_snapshots;
create policy "audience_snapshots_select_members" on audience_snapshots
  for select using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

drop policy if exists recurring_schedules_all_own on recurring_schedules;
create policy "recurring_schedules_all_members" on recurring_schedules
  for all using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null))
  with check (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

-- Join-chain table (no account_id column of its own) -- correctly
-- expressed as a single EXISTS join in the original 0025 policy, just not
-- team-aware. Adding an explicit with check this time too: FOR ALL without
-- one falls back to reusing USING, which happens to be correct here, but
-- writing it out avoids relying on that fallback.
drop policy if exists recurring_schedule_targets_all_own on recurring_schedule_targets;
create policy "recurring_schedule_targets_all_members" on recurring_schedule_targets
  for all using (
    exists (
      select 1 from recurring_schedules rs
      join account_members am on am.account_id = rs.account_id
      where rs.id = recurring_schedule_targets.recurring_schedule_id
        and am.user_id = auth.uid() and am.accepted_at is not null
    )
  )
  with check (
    exists (
      select 1 from recurring_schedules rs
      join account_members am on am.account_id = rs.account_id
      where rs.id = recurring_schedule_targets.recurring_schedule_id
        and am.user_id = auth.uid() and am.accepted_at is not null
    )
  );

drop policy if exists google_calendar_connections_all_own on google_calendar_connections;
create policy "google_calendar_connections_all_members" on google_calendar_connections
  for all using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null))
  with check (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

drop policy if exists google_sheets_connections_all_own on google_sheets_connections;
create policy "google_sheets_connections_all_members" on google_sheets_connections
  for all using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null))
  with check (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

-- account_members' own SELECT: was owner-only visibility of the roster
-- (a non-owner teammate could see their own row via the OTHER existing
-- policy, but never their teammates). Broadened to whole-team visibility,
-- kept alongside the existing own-row policy rather than replacing it --
-- a superset for accepted members, but harmless to leave both.
create policy "account_members_select_team" on account_members
  for select using (account_id in (select am2.account_id from account_members am2 where am2.user_id = auth.uid() and am2.accepted_at is not null));

-- ============================================================
-- Tables with RLS enabled but NO policy ever written -- total lockout
-- risk under real enforcement, not narrow bugs.
-- ============================================================

create policy "brands_all_members" on brands
  for all using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null))
  with check (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

create policy "dm_automations_all_members" on dm_automations
  for all using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null))
  with check (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

-- SELECT-only: only the backend/AI writes rows here, never a customer
-- directly.
create policy "dm_automation_log_select_members" on dm_automation_log
  for select using (
    exists (
      select 1 from dm_automations da
      join account_members am on am.account_id = da.account_id
      where da.id = dm_automation_log.automation_id
        and am.user_id = auth.uid() and am.accepted_at is not null
    )
  );

-- SELECT-only: the triage inbox is read-facing, backend/AI populates it.
create policy "comment_triage_select_members" on comment_triage
  for select using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));

-- api_keys: deliberately NOT the same team-wide-for-everything shape as
-- the tables above. Viewing which keys exist can be team-wide; minting or
-- revoking one is more sensitive (it's a standing credential, not a
-- content object), so INSERT/DELETE stay owner-only. Matches
-- requireOwner's existing gate on the actual create/revoke routes
-- (routes.ts) -- this policy mirrors that boundary rather than loosening it.
create policy "api_keys_select_members" on api_keys
  for select using (account_id in (select account_id from account_members where user_id = auth.uid() and accepted_at is not null));
create policy "api_keys_insert_owner" on api_keys
  for insert with check (account_id = auth.uid());
create policy "api_keys_delete_owner" on api_keys
  for delete using (account_id = auth.uid());
