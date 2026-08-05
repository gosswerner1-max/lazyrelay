#!/usr/bin/env node
// Generic self-test harness for LazyRelay ops Auditors.
//
// Adapted from The Lazy Download's automation2/tests/run_gate_selftest.py:
// same fail-closed, known-bad/known-good, "prove it before trusting it"
// discipline — but fixtures are JSON state snapshots (fixture.snapshot +
// fixture.expectFlagged) instead of file artifacts (PDF/image), since
// billing/accounts state transitions have no file to fixture-test.
//
// Usage: node runSelfTest.js <auditor-name>
//   e.g. node runSelfTest.js accounts_auditor
//
// Looks for ../oversight/<auditor-name>.js exposing check(fixturePath),
// runs it against fixtures/<auditor-name>/known_bad/*.json (must report
// pass:true, meaning "correctly flagged") and known_good/*.json (must also
// report pass:true, meaning "correctly NOT flagged" — check()'s pass field
// always means "matched the fixture's expectFlagged", for both folders).
// Writes selftest_results/<auditor-name>.json with per-case results,
// module mtime, and overall_pass.

const fs = require("fs");
const path = require("path");

function runSelfTest(auditorName) {
  const modulePath = path.join(__dirname, "..", "oversight", `${auditorName}.js`);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`No auditor module found at ${modulePath}`);
  }
  const { check } = require(modulePath);
  if (typeof check !== "function") {
    throw new Error(`${modulePath} does not export a check(fixturePath) function`);
  }

  const fixtureRoot = path.join(__dirname, "fixtures", auditorName);
  const cases = [];
  for (const bucket of ["known_bad", "known_good"]) {
    const dir = path.join(fixtureRoot, bucket);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const fixturePath = path.join(dir, file);
      const { pass, reason } = check(fixturePath);
      cases.push({ bucket, file, pass, reason });
    }
  }

  const overallPass = cases.length > 0 && cases.every((c) => c.pass);
  const result = {
    auditorName,
    moduleMtime: fs.statSync(modulePath).mtime.toISOString(),
    cases,
    overallPass,
    ranAt: new Date().toISOString(),
  };

  const resultsDir = path.join(__dirname, "selftest_results");
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${auditorName}.json`), JSON.stringify(result, null, 2));
  return result;
}

/** Fail-closed check an orchestrator must call before invoking a gate live:
 * refuses if no result, if it failed, or if the module was edited since
 * the last recorded pass. */
function checkAuditorIsProven(auditorName) {
  const resultsPath = path.join(__dirname, "selftest_results", `${auditorName}.json`);
  if (!fs.existsSync(resultsPath)) return { proven: false, reason: "no self-test result on record" };
  const result = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  if (!result.overallPass) return { proven: false, reason: "last self-test run failed" };

  const modulePath = path.join(__dirname, "..", "oversight", `${auditorName}.js`);
  const currentMtime = fs.statSync(modulePath).mtime.toISOString();
  if (currentMtime !== result.moduleMtime) {
    return { proven: false, reason: "module edited since last recorded self-test pass — stale" };
  }
  return { proven: true, reason: "ok" };
}

module.exports = { runSelfTest, checkAuditorIsProven };

if (require.main === module) {
  const auditorName = process.argv[2];
  if (!auditorName) {
    console.error("Usage: node runSelfTest.js <auditor-name>");
    process.exit(1);
  }
  const result = runSelfTest(auditorName);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.overallPass ? 0 : 1);
}
