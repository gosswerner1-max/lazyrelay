-- Fixes the Supabase Performance Advisor's "Multiple Permissive Policies"
-- finding (6 warnings, all one root cause), deliberately left out of
-- migration 0089 for needing real design care. account_members has had 3
-- separate permissive SELECT policies since 0053/0081/0082:
--   account_members_select_own_membership  -- auth.uid() = user_id
--   account_members_select_as_account_owner -- auth.uid() = account_id
--   account_members_select_team             -- is_account_member(account_id)
-- Confirmed via grep across every migration that these are the ONLY
-- policies ever defined on this table (no insert/update/delete policies
-- exist -- all writes go through the backend's service-role key, which
-- bypasses RLS entirely per 0081's own comment).
--
-- Postgres already ORs together every permissive policy that matches a
-- query, so three separate policies for the same role+action were always
-- logically one OR condition -- just evaluated as three separate checks
-- per query instead of one. This migration writes that OR explicitly as a
-- single policy. Same three conditions, verbatim, so the set of visible
-- rows is provably unchanged:
--   - a user can always see their own row (including a pending invite
--     before accepted_at is set -- needed so they can see/accept it)
--   - an account owner can see every row under their own account (kept
--     even though is_account_member() already covers owners in practice,
--     since owners get an accepted membership row at signup -- this
--     condition is cheap and removing it would rely on that always being
--     true, which isn't worth the risk for a one-line OR clause)
--   - any accepted team member can see every row under that account
--
-- RLS here is defense-in-depth only, not the live enforcement path (see
-- 0081's own comment) -- this migration changes nothing about real app
-- behavior, only how many policy evaluations one account_members read
-- costs.

drop policy if exists account_members_select_own_membership on account_members;
drop policy if exists account_members_select_as_account_owner on account_members;
drop policy if exists account_members_select_team on account_members;

create policy "account_members_select_visible" on account_members
  for select using (
    (select auth.uid()) = user_id
    or (select auth.uid()) = account_id
    or is_account_member(account_id)
  );
