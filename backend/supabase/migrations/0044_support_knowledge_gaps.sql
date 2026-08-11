-- Support knowledge gaps (2026-08-11) — every time the AI support widget
-- can't answer something itself and escalates (see the [[ESCALATE:...]]
-- tag handling in routes.ts POST /support/chat), the same question also
-- lands here. A weekly scheduled job reads the new rows, drafts a
-- candidate answer for each grounded only in real verified sources (never
-- freehand invention), and posts a digest to Werner in Slack for approval
-- before anything is added to SUPPORT_KNOWLEDGE.md or chatKnowledge.ts.
--
-- Not tied to any single account_id — a gap is a product-knowledge fact
-- missing for everyone, not a per-customer record, same reasoning as
-- admin_audit_log (0035) being account-independent.
create table support_knowledge_gaps (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  escalation_category text not null check (escalation_category in ('hello', 'support', 'accounts')),
  question_summary text not null,
  transcript text not null,
  status text not null default 'new' check (status in ('new', 'drafted', 'approved', 'rejected', 'applied')),
  draft_answer text,
  suggested_target text,
  applied_at timestamptz
);

create index support_knowledge_gaps_status_idx on support_knowledge_gaps (status);
create index support_knowledge_gaps_created_at_idx on support_knowledge_gaps (created_at);

alter table support_knowledge_gaps enable row level security;
