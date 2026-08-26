// Support Knowledge Gap Operator — thin data access for support_knowledge_gaps
// (migration 0044). Every time the AI support widget escalates something it
// couldn't answer (backend/src/http/routes.ts POST /support/chat), a row
// lands here. The weekly digest task reads new rows, does the actual
// research/drafting itself (real judgment, not scripted here), writes the
// draft back via markGapDrafted, then posts one Slack digest for Werner's
// approval. Nothing in this file ever touches SUPPORT_KNOWLEDGE.md,
// chatKnowledge.ts, Slack, or an LLM call directly — pure Supabase CRUD,
// same split as accounts_ops.js/billing_ops.js keeping data access separate
// from the judgment calls made in the scheduled task's own prompt.

/** New, unprocessed escalations — what the weekly digest works through. */
async function getNewGaps(supabase) {
  const { data, error } = await supabase
    .from("support_knowledge_gaps")
    .select("id, created_at, escalation_category, question_summary, transcript")
    .eq("status", "new")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Records a researched draft against a gap (or several, if duplicates were
 * merged into one answer — call once per row either way, never skip a row
 * silently, so nothing sits in "new" forever just because it looked like a
 * dupe of something already handled). */
async function markGapDrafted(supabase, id, { draftAnswer, suggestedTarget }) {
  const { error } = await supabase
    .from("support_knowledge_gaps")
    .update({ status: "drafted", draft_answer: draftAnswer, suggested_target: suggestedTarget })
    .eq("id", id);
  if (error) throw error;
}

/** Called once Werner has approved/rejected a drafted gap in a real session
 * (not by the weekly digest task itself — approval is a human step). */
async function markGapReviewed(supabase, id, { status, appliedAt }) {
  if (!["approved", "rejected", "applied"].includes(status)) {
    throw new Error(`markGapReviewed: invalid status "${status}"`);
  }
  const { error } = await supabase
    .from("support_knowledge_gaps")
    .update({ status, ...(appliedAt ? { applied_at: appliedAt } : {}) })
    .eq("id", id);
  if (error) throw error;
}

/** Retention: `transcript` carries the customer's real email plus the full
 * conversation (see routes.ts's escalation handler) — genuinely needed
 * while a gap is still being drafted/reviewed/replied to, but there's no
 * reason to keep that PII forever once a gap has reached a terminal state
 * (found live 2026-08-26 during a log-hygiene security pass). Only ever
 * purges 'rejected'/'applied' rows — never 'new'/'drafted'/'approved',
 * which the digest/approval flow may still need regardless of age. Default
 * 90 days mirrors the account data-retention window's order of magnitude
 * (data_retention_ops.js) without being tied to it — this table isn't
 * account-scoped. */
const DEFAULT_RETENTION_DAYS = 90;

async function purgeOldResolvedGaps(supabase, retentionDays = DEFAULT_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("support_knowledge_gaps")
    .delete()
    .in("status", ["rejected", "applied"])
    .lt("created_at", cutoff)
    .select("id");
  if (error) throw error;
  return { purged: (data ?? []).length, cutoff };
}

module.exports = { getNewGaps, markGapDrafted, markGapReviewed, purgeOldResolvedGaps, DEFAULT_RETENTION_DAYS };
