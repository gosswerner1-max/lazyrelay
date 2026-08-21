// Accounts Auditor — flag-only, never mutates anything. Independently
// re-checks account state consistency. Mirrors The Lazy Download's
// website_auditor.py shape (reads, reports {checked, flaggedCount,
// problems}), adapted with a JSON-snapshot fixture convention instead of
// file-artifact fixtures, since there's no PDF/image to check here — see
// ops/tests/README for the adapted self-test convention.

const fs = require("fs");
const { getSupabaseClient } = require("../shared/supabaseClient.js");

const STUCK_THRESHOLD_DAYS = 30;
const VALID_STATUSES = ["trialing", "active", "past_due", "cancelled"];

/** Pure function: given one account's real-world snapshot, decide if it's
 * flag-worthy. No I/O — this is what both the live audit and the self-test
 * fixtures exercise. */
function evaluateAccountSnapshot(snapshot) {
  const reasons = [];
  const daysSinceCreated = (Date.now() - new Date(snapshot.createdAt).getTime()) / 86400000;

  // No subscription row at all is a normal, expected state for a fresh
  // signup (handle_new_user() only creates the accounts row) — only a
  // PRESENT-but-unrecognized status string is real schema drift.
  if (snapshot.subscriptionStatus != null && !VALID_STATUSES.includes(snapshot.subscriptionStatus)) {
    reasons.push(`unknown subscription status "${snapshot.subscriptionStatus}" — schema drift?`);
  }
  if (
    snapshot.subscriptionStatus === "active" &&
    snapshot.connectedAccountsCount === 0 &&
    daysSinceCreated >= STUCK_THRESHOLD_DAYS
  ) {
    reasons.push(`active subscription but 0 connected accounts for ${Math.round(daysSinceCreated)}+ days`);
  }

  return { flagged: reasons.length > 0, reasons };
}

/** Self-test entry point: fixture JSON = {snapshot, expectFlagged}.
 * Returns {pass, reason} — pass means the evaluator's real output matched
 * what the fixture says it should be. */
function check(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const result = evaluateAccountSnapshot(fixture.snapshot);
  const pass = result.flagged === fixture.expectFlagged;
  return {
    pass,
    reason: pass
      ? "ok"
      : `expected flagged=${fixture.expectFlagged}, got flagged=${result.flagged} (${result.reasons.join("; ") || "no reasons"})`,
  };
}

/** Real audit against live Supabase data. Flag-only — reports, never fixes.
 * Batched 2026-08-21 (a real gap found during a scaling review): this used
 * to make 2 extra queries PER account inside the loop (a subscription
 * lookup, a connected-accounts count) — fine at dozens of accounts, real
 * drag at real volume. Now one query for every account's subscription and
 * one for every account's connected-accounts count, each via .in(), with
 * the join done in memory instead of round-tripping per account. */
async function runLiveAudit(supabase) {
  const { data: accounts, error } = await supabase
    .from("accounts")
    .select("id, email, created_at")
    .is("cancelled_at", null);
  if (error) throw error;

  const accountIds = (accounts ?? []).map((a) => a.id);
  const [{ data: subs, error: subsError }, { data: socialAccounts, error: socialError }] = await Promise.all([
    accountIds.length
      ? supabase.from("subscriptions").select("account_id, status").in("account_id", accountIds)
      : { data: [], error: null },
    accountIds.length
      ? supabase.from("social_accounts").select("account_id").in("account_id", accountIds).is("disconnected_at", null)
      : { data: [], error: null },
  ]);
  if (subsError) throw subsError;
  if (socialError) throw socialError;

  const statusByAccount = new Map((subs ?? []).map((s) => [s.account_id, s.status]));
  const connectedCountByAccount = new Map();
  for (const row of socialAccounts ?? []) {
    connectedCountByAccount.set(row.account_id, (connectedCountByAccount.get(row.account_id) ?? 0) + 1);
  }

  const problems = [];
  for (const account of accounts ?? []) {
    const snapshot = {
      accountId: account.id,
      subscriptionStatus: statusByAccount.get(account.id) ?? null,
      connectedAccountsCount: connectedCountByAccount.get(account.id) ?? 0,
      createdAt: account.created_at,
    };
    const result = evaluateAccountSnapshot(snapshot);
    if (result.flagged) problems.push({ accountId: account.id, email: account.email, reasons: result.reasons });
  }

  return { checked: (accounts ?? []).length, flaggedCount: problems.length, problems };
}

module.exports = { evaluateAccountSnapshot, check, runLiveAudit };

if (require.main === module) {
  (async () => {
    const supabase = getSupabaseClient();
    const result = await runLiveAudit(supabase);
    console.log(JSON.stringify(result, null, 2));
  })().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
