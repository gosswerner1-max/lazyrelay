-- 0134: a signed-in browser can write only brand_id, brand_label and disconnected_at on public.social_accounts, nothing else.
--
-- Why. The browser-facing role `authenticated` currently holds INSERT and UPDATE on every column of public.social_accounts. Row level
-- security limits each caller to their own account's rows, but the connection state and the pointers to stored credentials are columns
-- that only the backend should change. This migration narrows the browser role to the columns the dashboard actually writes.
--
-- What still has to work. The backend uses the service role, which bypasses these grants, so every server-side writer is unaffected.
-- The dashboard routes run as `authenticated` (requireAuth gives them req.db) and write this table in four places: DELETE
-- /social-accounts/:id (disconnected_at), PATCH /social-accounts/:id (brand_id, brand_label) and the brand_label mirror in
-- PATCH /brands/:id and DELETE /brands/:id. So UPDATE is given back on exactly those three columns and no others. Row scope is
-- unchanged: the existing RLS update policy still limits a caller to their own account. The test
-- src/socialAccountsUserClientWrites.test.ts fails if a new req.db write to this table appears outside the granted columns.
-- SELECT and DELETE stay as they are, and every existing RLS policy is left unchanged.
--
-- Idempotent: REVOKE of a privilege that is not held changes nothing (a table level REVOKE also removes any column level grants, so the
-- GRANT after it is what leaves the three columns writable), and GRANT of a privilege already held changes nothing.
--
-- ROLLBACK (manual): grant insert, update on public.social_accounts to authenticated;

begin;

revoke insert, update on public.social_accounts from authenticated;

grant update (brand_id, brand_label, disconnected_at) on public.social_accounts to authenticated;

commit;
