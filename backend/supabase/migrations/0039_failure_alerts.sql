-- Proactive failure alerts (2026-08-08) — checklist item 7 from
-- project-competitor-feature-audit-2026-08-07.md. Opt-IN, off by default —
-- Werner's real product call: most customers won't want an email every time
-- a post fails, but someone using LazyRelay as an income source will. A
-- surprise email nobody asked for is worse than a missed opt-in, so this
-- defaults to false rather than true-with-an-opt-out.
alter table accounts add column email_failure_alerts_enabled boolean not null default false;
