-- 0142: the reason a post is waiting for credits, so the dashboard can show it.
--
-- NOT applied anywhere. Apply by hand with the owner's yes, after 0141. Additive and idempotent: no row is rewritten.
-- The publisher (scheduler.ts, wallet on only) writes a short plain sentence here when a post cannot be paid for yet and clears it when
-- the post goes out. Null means nothing is holding the post. With the wallet off nothing ever writes this column.
--
-- ROLLBACK (manual): alter table public.scheduled_posts drop column if exists wallet_hold_reason;

begin;

alter table public.scheduled_posts add column if not exists wallet_hold_reason text;

commit;
