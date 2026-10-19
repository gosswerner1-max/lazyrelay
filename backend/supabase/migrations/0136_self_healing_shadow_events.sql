-- 0136: self_healing_shadow_events, one row per decision the new self-healing policy would have made while it runs in shadow mode.
--
-- DRAFT for review on branch feature/stage3-self-healing. NOT applied anywhere. Apply by hand with Werner's yes, on a throwaway
-- Supabase branch first (the repo has no SQL test harness: this file has only been read and checked as text).
--
-- Why. SELF_HEALING_MODE=shadow lets the old retry logic keep making every decision while the new policy is evaluated on the same
-- inputs. Each evaluation is recorded here so a week of real traffic can be read (ops/self-healing/shadow-report.js) before anyone
-- switches the mode to "on".
--
-- What it stores: ids, the platform name, fixed codes, delays and a lateness figure. NEVER post content, a token, a key, an email
-- address or any error text, and there is no column that could hold one. Rows older than 30 days are purged by the backend.
--
-- Access: service only. RLS is on with NO policy, and the browser-facing roles hold no privilege. There are no foreign keys, so a
-- row outlives a deleted post or connection.
--
-- Idempotent (safe to apply twice) and wrapped in one transaction.
--
-- ROLLBACK (by hand; it deletes the shadow history):
--   drop table if exists public.self_healing_shadow_events;

begin;

create table if not exists public.self_healing_shadow_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  mode text not null check (mode in ('shadow', 'on')),
  source text not null check (source in ('post', 'breaker', 'whatsapp', 'alert')),
  post_id uuid,
  social_account_id uuid,
  platform text not null,
  error_class text check (error_class in ('transient', 'rate_limited', 'auth', 'fatal', 'ambiguous', 'unknown')),
  legacy_action text not null check (legacy_action in ('attempt', 'retry', 'reverify', 'fail', 'hold_connection', 'admit', 'deny_probe', 'reopen', 'owner_alert', 'pause_broadcast', 'none')),
  legacy_delay_ms bigint,
  new_action text not null check (new_action in ('attempt', 'retry', 'reverify', 'fail', 'hold_connection', 'admit', 'deny_probe', 'reopen', 'owner_alert', 'pause_broadcast', 'none')),
  new_delay_ms bigint,
  new_reason_code text check (new_reason_code in ('retries_exhausted', 'too_late', 'fatal', 'auth_rejected', 'unknown_error')),
  lateness_ms bigint,
  would_alert boolean not null default false,
  diverged boolean not null
);

create index if not exists self_healing_shadow_events_created_idx on public.self_healing_shadow_events (created_at desc);

alter table public.self_healing_shadow_events enable row level security;

-- No policy on purpose: only the backend's service-role client reads or writes this table.
revoke all on public.self_healing_shadow_events from public, anon, authenticated;
-- Explicit grant for the backend, because Supabase stops granting new tables to the API roles automatically on 2026-10-30.
grant all on public.self_healing_shadow_events to service_role;

commit;
