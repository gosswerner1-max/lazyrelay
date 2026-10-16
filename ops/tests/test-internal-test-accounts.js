// Tests for ops/shared/internalTestAccounts.js: extra internal addresses come from INTERNAL_TEST_EMAILS_EXTRA or the
// gitignored local file internal-test-accounts.local.json, and the module refuses to load without either one
// (outside CI/tests) so no automated send or deletion can ever treat an internal account as a customer.
// No network, no database. Run: node ops/tests/test-internal-test-accounts.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const modulePath = path.resolve(__dirname, "../shared/internalTestAccounts.js");
let pass = 0;
function t(label, fn) {
  try { fn(); pass++; console.log("PASS:", label); } catch (e) { console.error("FAIL:", label, "-", e.message); process.exitCode = 1; }
}
// Run the module in a fresh process with a controlled environment and local file location.
function load(env, localFile) {
  const code = `
    const m = require(${JSON.stringify(modulePath)});
    console.log(JSON.stringify({
      family: m.isInternalTestAccount("family.member@example.test"),
      aliased: m.isInternalTestAccount("Other.Person+x@Gmail.com"),
      stranger: m.isInternalTestAccount("stranger@gmail.com"),
      base: m.isInternalTestAccount("goss.werner.1@gmail.com"),
    }));`;
  const cleanEnv = { ...process.env };
  delete cleanEnv.INTERNAL_TEST_EMAILS_EXTRA; delete cleanEnv.CI; delete cleanEnv.NODE_ENV;
  return spawnSync(process.execPath, ["-e", code], {
    env: { ...cleanEnv, ...env, ...(localFile ? { INTERNAL_TEST_ACCOUNTS_FILE: localFile } : {}) },
    encoding: "utf8",
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-accts-"));
const goodFile = path.join(dir, "local.json");
fs.writeFileSync(goodFile, JSON.stringify({ emails: ["Family.Member@example.test", "other.person@gmail.com"] }));

t("the source file does not contain a family member's mailbox", () => {
  const allowed = new Set(["goss.werner.1@gmail.com", "lazyrelay+reviewer@gmail.com", "lazyrelay@gmail.com"]);
  // only quoted strings count: comments may show example addresses, the hardcoded list is made of strings
  const strings = [...fs.readFileSync(modulePath, "utf8").matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2].toLowerCase());
  const found = strings.flatMap((s) => s.match(/[a-z0-9._+-]+@(?:gmail|googlemail|outlook|hotmail|yahoo|icloud|proton)\.[a-z.]+/g) || []);
  assert.deepEqual(found.filter((e) => !allowed.has(e)), []);
});

t("extra addresses from INTERNAL_TEST_EMAILS_EXTRA are internal (case-insensitive, gmail aliases)", () => {
  const r = load({ INTERNAL_TEST_EMAILS_EXTRA: "family.member@example.test, Other.Person@Gmail.com" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { family: true, aliased: true, stranger: false, base: true });
});

t("extra addresses from the local file are internal too", () => {
  const r = load({}, goodFile);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { family: true, aliased: true, stranger: false, base: true });
});

t("with neither source the module refuses to load (fail closed)", () => {
  const r = load({}, path.join(dir, "missing.json"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /INTERNAL_TEST_EMAILS_EXTRA/);
});

t("in CI or tests the module still loads without extras (CI only parses and runs unit tests)", () => {
  const r = load({ CI: "true" }, path.join(dir, "missing.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).family, false);
});

console.log(pass + " passed");
