-- A post the customer chose to save as a DRAFT on the target platform (WordPress, dev.to, Hashnode) is a
-- finished job, not a failure: the platform holds it, nothing is public, so there is nothing to verify live.
-- This marks that result so the scheduler ends the post cleanly (no retries) and analytics leave it out of
-- the published and verified-live counts.
alter table post_results add column saved_as_draft boolean not null default false;
