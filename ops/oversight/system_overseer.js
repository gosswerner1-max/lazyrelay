// System Overseer — cross-domain health check. Same shape as The Lazy
// Download's automation2/oversight/system_overseer.py: reads every
// domain's Auditor self-test status and knowledge-file presence, writes
// findings back into THAT DOMAIN's OWN state file (not just a central
// report, so "Billing has an unresolved issue" is visible right where the
// Billing Operator looks on its next run), and produces one consolidated
// report. Never executes/triggers domain work itself — flag-only, same
// discipline as every per-domain Auditor, just at cross-domain scale.
//
// Built LAST, per the plan, once Accounts/Billing/Marketing/Advertising
// each have real, running Operators/Auditors to check.

const fs = require("fs");
const path = require("path");
const { StateStore } = require("../shared/stateStore.js");
const { checkAuditorIsProven } = require("../tests/runSelfTest.js");

const DOMAIN_AUDITORS = {
  accounts: "accounts_auditor",
  billing: "billing_auditor",
  marketing: "marketing_auditor",
  advertising: "advertising_auditor",
};

const DOMAIN_KNOWLEDGE_FILES = {
  accounts: path.join(__dirname, "..", "accounts", "ACCOUNTS_KNOWLEDGE.md"),
  billing: path.join(__dirname, "..", "billing", "BILLING_KNOWLEDGE.md"),
  marketing: path.join(__dirname, "..", "marketing", "MARKETING_KNOWLEDGE.md"),
  advertising: path.join(__dirname, "..", "advertising", "ADVERTISING_KNOWLEDGE.md"),
};

function checkDomainHealth(domain) {
  const auditorName = DOMAIN_AUDITORS[domain];
  const knowledgeFilePath = DOMAIN_KNOWLEDGE_FILES[domain];

  const auditorCheck = checkAuditorIsProven(auditorName);
  const knowledgeFileExists = fs.existsSync(knowledgeFilePath);
  const knowledgeFileNonEmpty = knowledgeFileExists && fs.statSync(knowledgeFilePath).size > 0;

  const healthy = auditorCheck.proven && knowledgeFileNonEmpty;
  const problems = [];
  if (!auditorCheck.proven) problems.push(`auditor not proven: ${auditorCheck.reason}`);
  if (!knowledgeFileExists) problems.push(`knowledge file missing: ${knowledgeFilePath}`);
  else if (!knowledgeFileNonEmpty) problems.push(`knowledge file empty: ${knowledgeFilePath}`);

  return { domain, healthy, auditorCheck, knowledgeFileExists, problems };
}

/** Runs the full cross-domain check. For any unhealthy domain, writes the
 * finding into THAT domain's own state file (e.g. accounts/state/) so its
 * own Operator/Auditor sees it on their next run, not just here. */
function runFullCheck() {
  const results = Object.keys(DOMAIN_AUDITORS).map(checkDomainHealth);

  for (const result of results) {
    // Always write, not just on failure — a domain that WAS unhealthy and is
    // now fine needs its own flag file updated to say so, otherwise a stale
    // "unhealthy" flag from a prior run sits there indefinitely even after
    // the domain recovers (found 2026-07-28: accounts_overseer_flags.json
    // still showed a 2026-07-22 failure days after accounts started passing).
    const domainStatePath = path.join(__dirname, "..", result.domain, "state", `${result.domain}_overseer_flags.json`);
    const domainStore = new StateStore(domainStatePath);
    domainStore.mark("latest_overseer_flag", { problems: result.problems, healthy: result.healthy });
  }

  const summary = {
    ranAt: new Date().toISOString(),
    results,
    allHealthy: results.every((r) => r.healthy),
  };

  const overseerStore = new StateStore(path.join(__dirname, "state", "system_overseer_state.json"));
  overseerStore.mark("latest_run", summary);

  return summary;
}

module.exports = { checkDomainHealth, runFullCheck, DOMAIN_AUDITORS, DOMAIN_KNOWLEDGE_FILES };

if (require.main === module) {
  const summary = runFullCheck();
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.allHealthy ? 0 : 1);
}
