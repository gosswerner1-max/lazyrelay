// Advertising Operator — paid customer-acquisition recommendations for
// LazyRelay. DORMANT/RECOMMENDATION-ONLY: no ad account exists yet. Same
// shape as marketing_ops.js and The Lazy Download's Etsy Ads domain —
// queues recommendations for human review, never spends anything.

const { StateStore } = require("../shared/stateStore.js");
const { evaluateAdRecommendation } = require("../oversight/advertising_auditor.js");
const path = require("path");

function getStateStore() {
  return new StateStore(path.join(__dirname, "state", "pending_recommendations.json"));
}

/** Each item: {platform, targetAudience, rationale, budgetUsd}. budgetUsd
 * must be 0/null/undefined — no ad account exists to spend against yet. */
function queueAdRecommendations(items) {
  const store = getStateStore();
  const accepted = [];
  const rejected = [];

  for (const item of items) {
    const result = evaluateAdRecommendation(item);
    if (result.flagged) {
      rejected.push({ item, reasons: result.reasons });
    } else {
      const key = `${item.platform}_${Date.now()}_${accepted.length}`;
      store.mark(key, { ...item, status: "pending_review", live: false });
      accepted.push(key);
    }
  }

  return { live: false, accepted, rejected, note: "DORMANT — no ad account exists yet, nothing spends." };
}

function listPendingRecommendations() {
  return getStateStore().all();
}

module.exports = { queueAdRecommendations, listPendingRecommendations };
