-- Adds a "needs_approval" status — a post created with requiresApproval
-- sits here until explicitly approved (flipped to "pending"), instead of
-- being immediately eligible for the scheduler to pick up.
--
-- This is a real, working approval GATE, not full multi-person team
-- accounts: LazyRelay's identity model is still one Supabase auth user per
-- account (see requireAuth — req.accountId IS the auth user's own id, no
-- account_members/workspace table exists). Anyone authenticated as this
-- account can approve — there's no separate "approver" role yet. True
-- per-person roles would mean introducing a real membership table and
-- rewriting every RLS policy in this schema (they all key off
-- `auth.uid() = account_id` directly) — a genuinely larger, separate
-- architectural change, not a follow-on to this migration.

alter table scheduled_posts drop constraint scheduled_posts_status_check;
alter table scheduled_posts add constraint scheduled_posts_status_check
  check (status in ('pending', 'posting', 'posted', 'failed', 'needs_approval'));
