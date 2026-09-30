-- Keep the platform's raw error text for support and debugging.
--
-- post_results.error_message is what the customer sees in their History tab
-- and in failure emails. From now on it holds a plain-language reason (see
-- postErrors.ts); the original text from the platform is kept here so nothing
-- useful is lost. Additive and nullable: no backfill, no change to existing
-- reads or RLS.

alter table post_results
  add column if not exists raw_error_message text;
