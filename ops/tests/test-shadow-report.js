// Tests for ops/self-healing/shadow-report.js (the one week shadow trial report). No network, no database: a fake client stands in.
// Run: node ops/tests/test-shadow-report.js
const assert = require("node:assert/strict");
const { buildReport, renderReport, fetchRows, PAGE_SIZE } = require("../self-healing/shadow-report.js");

let pass = 0;
function t(label, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log("PASS:", label); })
    .catch((e) => { console.error("FAIL:", label, "-", e.message); process.exitCode = 1; });
}

const H = 3_600_000;
const row = (over = {}) => ({
  created_at: "2026-10-20T10:00:00.000Z",
  mode: "shadow",
  source: "post",
  platform: "bluesky",
  error_class: "transient",
  legacy_action: "retry",
  legacy_delay_ms: 240000,
  new_action: "retry",
  new_delay_ms: 300000,
  new_reason_code: null,
  lateness_ms: 60000,
  would_alert: false,
  diverged: true,
  ...over,
});

t("counts rows by platform, error class, legacy action and new action", () => {
  const r = buildReport([row(), row({ platform: "x" }), row({ error_class: "fatal", legacy_action: "fail", new_action: "fail", new_reason_code: "fatal", diverged: false })]);
  assert.equal(r.total, 3);
  assert.deepEqual(r.byPlatform, { bluesky: 2, x: 1 });
  assert.deepEqual(r.byErrorClass, { transient: 2, fatal: 1 });
  assert.deepEqual(r.byLegacyAction, { retry: 2, fail: 1 });
  assert.deepEqual(r.byNewAction, { retry: 2, fail: 1 });
});

t("counts how often they diverge, overall and for each legacy to new pair", () => {
  const r = buildReport([row(), row(), row({ diverged: false }), row({ legacy_action: "fail", new_action: "retry", diverged: true })]);
  assert.equal(r.diverged, 3);
  assert.equal(r.divergedPercent, 75);
  assert.deepEqual(r.pairs, [
    { legacy: "retry", next: "retry", count: 3, diverged: 2 },
    { legacy: "fail", next: "retry", count: 1, diverged: 1 },
  ]);
});

t("the share of events the new policy would have failed as too_late, split into claim time and retry time", () => {
  const rows = [
    row(),
    row(),
    row({ legacy_action: "attempt", new_action: "fail", new_reason_code: "too_late", lateness_ms: 3 * H }),
    row({ legacy_action: "retry", new_action: "fail", new_reason_code: "too_late", lateness_ms: 100 * 60000 }),
  ];
  const r = buildReport(rows);
  assert.equal(r.tooLate.total, 2);
  assert.equal(r.tooLate.sharePercent, 50);
  assert.equal(r.tooLate.atClaim, 1);
  assert.equal(r.tooLate.atRetry, 1);
});

t("a claim time too_late on a post that was not 2 hours late is flagged as unexpected, a retry time one is not", () => {
  const unexpected = buildReport([row({ legacy_action: "attempt", new_action: "fail", new_reason_code: "too_late", lateness_ms: 90 * 60000 })]);
  assert.equal(unexpected.tooLate.unexpectedAtClaim, 1);
  const fine = buildReport([row({ legacy_action: "attempt", new_action: "fail", new_reason_code: "too_late", lateness_ms: 2 * H + 1 }), row({ legacy_action: "retry", new_action: "fail", new_reason_code: "too_late", lateness_ms: 100 * 60000 })]);
  assert.equal(fine.tooLate.unexpectedAtClaim, 0);
  assert.equal(fine.tooLate.retryUnderTwoHours, 1);
});

t("counts the owner alerts that would have gone out", () => {
  const r = buildReport([row({ source: "alert", platform: "whatsapp", legacy_action: "none", new_action: "owner_alert", would_alert: true }), row({ source: "alert", platform: "whatsapp", legacy_action: "none", new_action: "owner_alert", would_alert: true }), row()]);
  assert.equal(r.wouldAlert, 2);
});

t("an empty week gives zeros, not NaN", () => {
  const r = buildReport([]);
  assert.equal(r.total, 0);
  assert.equal(r.divergedPercent, 0);
  assert.equal(r.tooLate.sharePercent, 0);
});

t("the rendered report is plain text with every section and no dashes used as punctuation", () => {
  const text = renderReport(buildReport([row(), row({ legacy_action: "attempt", new_action: "fail", new_reason_code: "too_late", lateness_ms: 3 * H })]), { days: 7 });
  for (const heading of ["Shadow report", "By platform", "By error class", "Old action", "New action", "Diverged", "too_late", "Owner alerts"]) assert.ok(text.includes(heading), heading);
  assert.ok(!/[–—]/.test(text));
});

t("fetchRows only reads: it pages through the table with select and range, and never writes", async () => {
  const all = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => row({ platform: `p${i}` }));
  const calls = [];
  const db = {
    from(table) {
      calls.push(["from", table]);
      const q = {
        select(cols) { calls.push(["select", cols]); return q; },
        gte(c, v) { calls.push(["gte", c, v]); return q; },
        order(c) { calls.push(["order", c]); return q; },
        range(a, b) { calls.push(["range", a, b]); return Promise.resolve({ data: all.slice(a, b + 1), error: null }); },
        insert() { throw new Error("must not write"); },
        update() { throw new Error("must not write"); },
        delete() { throw new Error("must not write"); },
        upsert() { throw new Error("must not write"); },
      };
      return q;
    },
  };
  const rows = await fetchRows(db, new Date("2026-10-13T00:00:00.000Z"));
  assert.equal(rows.length, PAGE_SIZE + 5);
  assert.deepEqual(calls.filter((c) => c[0] === "from"), [["from", "self_healing_shadow_events"], ["from", "self_healing_shadow_events"]]);
  assert.ok(calls.every((c) => ["from", "select", "gte", "order", "range"].includes(c[0])));
});

t("fetchRows throws the database error instead of hiding it", async () => {
  const db = { from: () => ({ select() { return this; }, gte() { return this; }, order() { return this; }, range: () => Promise.resolve({ data: null, error: { message: "relation does not exist" } }) }) };
  await assert.rejects(() => fetchRows(db, new Date()), /relation does not exist/);
});

setTimeout(() => console.log(`${pass} passed`), 50);
