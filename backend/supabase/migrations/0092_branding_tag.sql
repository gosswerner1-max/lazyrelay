-- Free-tier "Scheduled via LazyRelay" branding tag (2026-09-28) -- one of
-- the two real gaps found auditing a Gemini growth-prompt Werner brought.
-- Deliberately ON by default for free tier, unlike email_failure_alerts_enabled
-- above (opt-in by default) -- this is a real growth mechanic Werner chose
-- to default on, with a removable opt-out, not a notification nobody asked
-- for. Paid tiers never see the tag regardless of this column's value.
alter table accounts add column show_branding_tag boolean not null default true;
