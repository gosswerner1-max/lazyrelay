-- 0138: social_accounts.whatsapp_fault_alert_sent_at, when the owner was last sent the WhatsApp trouble digest (decided by the owner 2026-10-19).
--
-- DRAFT for review on branch feature/stage3-self-healing. NOT applied anywhere. Apply by hand with the owner's yes, on a throwaway
-- Supabase branch first (the repo has no SQL test harness: this file has only been read and checked as text).
--
-- Why. While SELF_HEALING_MODE is on, a WhatsApp connection with enough failed sends (5 in a row, or at least 20 percent of the last 50,
-- with at least 10 sends) gets ONE plain email to its owner, and then no more for 6 hours. The backend keeps the time of the last one here,
-- so the rule survives a restart and two server instances cannot both send. The column is read and written by the backend only.
--
-- Who can write it. Nothing in this file grants anything: after 0134 the browser-facing role can update only brand_id, brand_label and
-- disconnected_at on this table, so this new column is not writable from a browser. (Apply 0134 first: before it, the browser role holds
-- UPDATE on every column of this table, and that is a gap in 0134's absence, not something this file can close.)
--
-- Idempotent (safe to apply twice) and wrapped in one transaction.
--
-- ROLLBACK (by hand):
--   alter table public.social_accounts drop column if exists whatsapp_fault_alert_sent_at;

begin;

alter table public.social_accounts add column if not exists whatsapp_fault_alert_sent_at timestamptz;

commit;
