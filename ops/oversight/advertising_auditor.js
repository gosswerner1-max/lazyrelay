// Advertising Auditor — flag-only. DORMANT: no ad account exists yet, so
// the only thing this checks is that any queued recommendation is
// genuinely recommendation-only (budget must be 0/null — a nonzero budget
// would mean something intends to actually spend, which isn't possible
// yet and would be a real bug in the Operator if it happened).

const fs = require("fs");

function evaluateAdRecommendation(item) {
  const reasons = [];
  if (item.budgetUsd && item.budgetUsd > 0) {
    reasons.push(`budgetUsd=${item.budgetUsd} but no ad account exists yet — this must stay recommendation-only (0/null)`);
  }
  if (!item.rationale || item.rationale.trim().length === 0) {
    reasons.push("missing rationale — every ad recommendation must state why");
  }
  return { flagged: reasons.length > 0, reasons };
}

function check(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const result = evaluateAdRecommendation(fixture.item);
  const pass = result.flagged === fixture.expectFlagged;
  return {
    pass,
    reason: pass
      ? "ok"
      : `expected flagged=${fixture.expectFlagged}, got flagged=${result.flagged} (${result.reasons.join("; ") || "no reasons"})`,
  };
}

module.exports = { evaluateAdRecommendation, check };
