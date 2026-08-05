// Billing Auditor — flag-only, never mutates. Independently checks
// subscription-state consistency, specifically the "paid but not
// activated"/stale-sync failure mode this whole processor decision was
// made to avoid, and tier-naming drift.

const fs = require("fs");
const { getSupabaseClient } = require("../shared/supabaseClient.js");

const VALID_TIERS = ["free", "pro", "business", "enterprise"];

/** Pure function: given one subscription's real-world snapshot, decide if
 * it's flag-worthy. No I/O. */
function evaluateSubscriptionSnapshot(snapshot) {
  const reasons = [];

  if (!VALID_TIERS.includes(snapshot.tier)) {
    reasons.push(`tier "${snapshot.tier}" not in the valid set (${VALID_TIERS.join("/")}) — schema drift?`);
  }

  const periodEnded = new Date(snapshot.currentPeriodEnd).getTime() < Date.now();
  if (snapshot.status === "active" && periodEnded) {
    reasons.push(
      "status=active but current_period_end has already passed — local record may be stale (missed/delayed webhook sync)"
    );
  }

  return { flagged: reasons.length > 0, reasons };
}

/** Self-test entry point: fixture JSON = {snapshot, expectFlagged}. */
function check(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const result = evaluateSubscriptionSnapshot(fixture.snapshot);
  const pass = result.flagged === fixture.expectFlagged;
  return {
    pass,
    reason: pass
      ? "ok"
      : `expected flagged=${fixture.expectFlagged}, got flagged=${result.flagged} (${result.reasons.join("; ") || "no reasons"})`,
  };
}

async function runLiveAudit(supabase) {
  const { data: subs, error } = await supabase
    .from("subscriptions")
    .select("id, account_id, tier, status, current_period_end");
  if (error) throw error;

  const problems = [];
  for (const sub of subs ?? []) {
    const snapshot = { tier: sub.tier, status: sub.status, currentPeriodEnd: sub.current_period_end };
    const result = evaluateSubscriptionSnapshot(snapshot);
    if (result.flagged) problems.push({ subscriptionId: sub.id, accountId: sub.account_id, reasons: result.reasons });
  }

  return { checked: (subs ?? []).length, flaggedCount: problems.length, problems };
}

module.exports = { evaluateSubscriptionSnapshot, check, runLiveAudit };

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
