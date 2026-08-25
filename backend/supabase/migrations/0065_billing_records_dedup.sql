-- Real gap found 2026-08-25 in the pre-launch audit: billing_records had no
-- unique constraint at all beyond its primary key, and recordSale()/
-- recordRefund() (billing/sync.ts) did a plain .insert() on every
-- transaction.completed/adjustment.created webhook. Paddle retries any
-- webhook delivery that doesn't get a clean 2xx (webhook.ts already has a
-- documented retry-backlog case), so a retried event would silently insert
-- a second sale/refund row for the same transaction, double-counting
-- revenue in this internal SARS bookkeeping table.
--
-- A plain unique constraint on paddle_transaction_id alone is wrong: a
-- refund row intentionally carries the SAME paddle_transaction_id as its
-- original sale row (that's how recordRefund() looks the sale up), so sale
-- and refund rows for one transaction would collide. And a partial unique
-- index scoped `where kind = 'sale'` hits the exact same PostgREST
-- ON CONFLICT-can't-infer-a-partial-index problem migration 0064 already
-- documented for scheduled_posts -- the Supabase JS client's
-- `.upsert(row, {onConflict})` has no way to also supply the index's WHERE
-- predicate, so Postgres can't match the constraint.
--
-- Fix, following 0064's same lesson (make it a real, non-partial column):
-- a generated column that's the transaction id for a sale row and the
-- adjustment id for a refund row. Each event's own dedup key is what's
-- actually unique in Paddle's model -- one paddle_transaction_id per sale,
-- one paddle_adjustment_id per refund (a transaction can have several
-- separate partial refunds, each a distinct adjustment id, which this
-- correctly allows) -- so this is a genuine total unique constraint, no
-- partial-index inference needed.
alter table billing_records
  add column paddle_event_key text
  generated always as (case when kind = 'sale' then paddle_transaction_id else paddle_adjustment_id end) stored;

alter table billing_records
  add constraint billing_records_event_key_key unique (paddle_event_key);
