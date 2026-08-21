// Accounts Operator — owns the customer-account state machine: new signup,
// unpaid/blocked, existing/active, connected-platform status. Reacts to
// Billing's subscriptions.status; never initiates money actions itself
// (that's billing_ops.js's job — see the domain split decided 2026-07-22).
//
// Grounded in the REAL schema (backend/supabase/migrations/):
//   accounts(id, email, created_at, cancelled_at)
//   subscriptions(account_id, tier, status, current_period_end, ...)
//   social_accounts(account_id, platform, connected_at, disconnected_at)
// There is no literal "blocked" enum anywhere — the plain-language bucket
// the user asked for (new / unpaid-blocked / existing) maps onto the real
// subscriptions.status values like this, documented in ACCOUNTS_KNOWLEDGE.md:
//   new          -> status = 'trialing', or 'active' with recent created_at
//   unpaid/blocked -> status = 'past_due'
//   existing     -> status = 'active', established (not recently created)

const { getSupabaseClient } = require("../shared/supabaseClient.js");
const { StateStore } = require("../shared/stateStore.js");
const { isInternalTestAccount } = require("../shared/internalTestAccounts.js");
const path = require("path");

const STUCK_ONBOARDING_DAYS = 7;
const REVIEW_REQUEST_MIN_VERIFIED_POSTS = 5;

function getReviewRequestStateStore() {
  return new StateStore(path.join(__dirname, "state", "review_requests.json"));
}

/** Accounts that signed up N+ days ago with zero connected social accounts —
 * candidates for a nudge, sent directly to the customer via Template 11 in
 * EMAIL_REPLY_TEMPLATES.md from support@lazyrelay.com (send-authority
 * approved 2026-08-05 — see feedback-email-agent-draft-and-hold.md in the
 * vault; this comment previously described the earlier draft-and-hold
 * policy, which was superseded before send-authority was ever granted). */
async function findStuckOnboardingAccounts(supabase, daysThreshold = STUCK_ONBOARDING_DAYS) {
  const cutoff = new Date(Date.now() - daysThreshold * 24 * 3600 * 1000).toISOString();
  const { data: accounts, error } = await supabase
    .from("accounts")
    .select("id, email, created_at")
    .lt("created_at", cutoff)
    .is("cancelled_at", null);
  if (error) throw error;

  const stuck = [];
  for (const account of accounts ?? []) {
    if (isInternalTestAccount(account.email)) continue; // never nudge our own test/internal accounts
    const { count, error: countError } = await supabase
      .from("social_accounts")
      .select("id", { count: "exact", head: true })
      .eq("account_id", account.id)
      .is("disconnected_at", null);
    if (countError) throw countError;
    if ((count ?? 0) === 0) stuck.push(account);
  }
  return stuck;
}

/**
 * Downgrade handling per the documented policy (SUPPORT_KNOWLEDGE.md:
 * "accounts beyond the new limit get paused, never auto-deleted").
 *
 * social_accounts.paused_at (migration 0013) closes the schema gap this
 * function used to just document: connected_at/disconnected_at alone
 * couldn't express "temporarily withheld, reversible on re-upgrade" without
 * destroying the connection. Oldest-connected-first stays active; the rest
 * get paused. Only accounts NOT already paused are set here, so re-running
 * this after a partial failure is idempotent.
 */
async function planDowngradePause(supabase, accountId, newAccountLimit) {
  const { data: connected, error } = await supabase
    .from("social_accounts")
    .select("id, platform, display_name, connected_at, paused_at")
    .eq("account_id", accountId)
    .is("disconnected_at", null)
    .order("connected_at", { ascending: true });
  if (error) throw error;

  const keep = (connected ?? []).slice(0, newAccountLimit);
  const pauseCandidates = (connected ?? []).slice(newAccountLimit).filter((a) => !a.paused_at);
  return { accountId, newAccountLimit, keep, pauseCandidates };
}

/** Actually pauses the accounts a prior planDowngradePause() call identified —
 * a separate step so a caller can review the plan before it takes effect. */
async function enforceDowngradePause(supabase, pauseCandidates) {
  if (pauseCandidates.length === 0) return { paused: [] };
  const ids = pauseCandidates.map((a) => a.id);
  const { error } = await supabase
    .from("social_accounts")
    .update({ paused_at: new Date().toISOString() })
    .in("id", ids)
    .is("paused_at", null); // don't stomp an existing pause timestamp
  if (error) throw error;
  return { paused: ids };
}

/** Reverses a pause on re-upgrade or reconnection — posting resumes for
 * these accounts on the very next scheduler poll, no other state to touch. */
async function unpauseAccounts(supabase, socialAccountIds) {
  if (socialAccountIds.length === 0) return { unpaused: [] };
  const { error } = await supabase
    .from("social_accounts")
    .update({ paused_at: null })
    .in("id", socialAccountIds);
  if (error) throw error;
  return { unpaused: socialAccountIds };
}

/**
 * Classifies an account's real subscriptions.status into the plain-language
 * bucket the user asked for, without inventing new schema.
 */
async function classifyAccountState(supabase, accountId) {
  const { data: sub, error } = await supabase
    .from("subscriptions")
    .select("status, tier, created_at")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  if (!sub) return "new_no_subscription";
  if (sub.status === "past_due") return "unpaid_blocked";
  if (sub.status === "trialing") return "new";
  if (sub.status === "cancelled") return "cancelled";
  return "existing";
}

/**
 * Review-request candidates — accounts with a real Proof-of-Publish milestone
 * (N+ posts confirmed actually live via post_results.verified_live, not just
 * "sent"), the same trust signal LazyRelay's own positioning is built on.
 * Excludes cancelled accounts and anything already marked in the review-
 * request StateStore, so no account is ever asked twice. Sent directly to
 * the customer via Template 12 from hello@lazyrelay.com (send-authority
 * approved 2026-08-05, same as the stuck-onboarding nudge above). See
 * ACCOUNTS_KNOWLEDGE.md.
 */
async function findReviewRequestCandidates(supabase, minVerifiedPosts = REVIEW_REQUEST_MIN_VERIFIED_POSTS) {
  const store = getReviewRequestStateStore();
  const { data: accounts, error } = await supabase
    .from("accounts")
    .select("id, email")
    .is("cancelled_at", null);
  if (error) throw error;

  const candidates = [];
  for (const account of accounts ?? []) {
    if (isInternalTestAccount(account.email)) continue; // never ask our own test/internal accounts for a review
    if (store.check(account.id).ok) continue; // already requested — never ask twice

    const { count, error: countError } = await supabase
      .from("post_results")
      .select("id", { count: "exact", head: true })
      .eq("account_id", account.id)
      .eq("verified_live", true);
    if (countError) throw countError;

    if ((count ?? 0) >= minVerifiedPosts) {
      candidates.push({ id: account.id, email: account.email, verifiedPostCount: count });
    }
  }
  return candidates;
}

/** Marks an account as having had a review request sent — call this only
 * once the email has actually been sent via imap-tool.js, so a run that
 * finds candidates but doesn't send (e.g. a dry-run) doesn't burn the mark. */
function markReviewRequested(accountId) {
  getReviewRequestStateStore().mark(accountId, { reviewRequested: true });
}

/** Creates the row backing the public star-rating feedback form (migration
 * 0063) and returns its token for the email link — call this once per
 * candidate, immediately before sending Template 12, then embed
 * `https://lazyrelay.com/feedback/${token}` in the email body. Postgres
 * generates the token (uuid default), not app code, same pattern as
 * account_members.invite_token. */
async function createFeedbackRequest(supabase, accountId) {
  const { data, error } = await supabase
    .from("review_feedback")
    .insert({ account_id: accountId })
    .select("token")
    .single();
  if (error) throw error;
  return data.token;
}

// Column -> the same question wording shown on FeedbackForm.tsx and in the
// internal notification email (backend/src/http/routes.ts's
// FEEDBACK_QUESTION_LABELS) -- kept in sync by hand since one lives in the
// frontend/backend TS build and this is a plain ops JS file with no shared
// import path between them.
const FEEDBACK_QUESTION_LABELS = [
  ["rating_overall", "Overall satisfaction"],
  ["rating_reliability", "Reliability"],
  ["rating_ease", "Ease of getting started"],
  ["rating_support", "Support"],
  ["rating_recommend", "Likelihood to recommend"],
];

/** Werner's call 2026-08-21: the daily digest needs a real way to see WHERE
 * to improve, not just that feedback exists. Averages every submitted
 * review_feedback row per question, sorted lowest-first so the weakest
 * area (the one most worth acting on) leads the list. Raw comments are
 * returned as-is, not summarized here -- spotting a recurring theme across
 * several customers' own words needs judgment, which belongs in the
 * digest-running agent reading them, not a scripted keyword match. */
async function getReviewFeedbackSummary(supabase) {
  const { data, error } = await supabase
    .from("review_feedback")
    .select("rating_overall, rating_reliability, rating_ease, rating_support, rating_recommend, comment, submitted_at")
    .not("submitted_at", "is", null);
  if (error) throw error;

  const rows = data ?? [];
  const questionAverages = FEEDBACK_QUESTION_LABELS.map(([column, label]) => {
    const values = rows.map((r) => r[column]).filter((v) => v !== null && v !== undefined);
    const average = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
    return { column, label, average: average === null ? null : Math.round(average * 10) / 10, responseCount: values.length };
  }).sort((a, b) => (a.average ?? 5) - (b.average ?? 5));

  const comments = rows.map((r) => r.comment).filter((c) => c && c.trim().length > 0);

  return { count: rows.length, questionAverages, comments };
}

module.exports = {
  findStuckOnboardingAccounts,
  planDowngradePause,
  enforceDowngradePause,
  unpauseAccounts,
  classifyAccountState,
  findReviewRequestCandidates,
  markReviewRequested,
  createFeedbackRequest,
  getReviewFeedbackSummary,
};
