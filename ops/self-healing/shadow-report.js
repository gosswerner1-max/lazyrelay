#!/usr/bin/env node
// Reads the shadow week (table self_healing_shadow_events, backend migration 0136) and prints what the new self-healing policy WOULD
// have done next to what the old logic did. READ ONLY: it only ever selects, it never writes, and it never sends anything.
//
// Run:  node ops/self-healing/shadow-report.js            (last 7 days)
//       node ops/self-healing/shadow-report.js --days 3
//       node ops/self-healing/shadow-report.js --json     (the same numbers as JSON)
// It uses the same service-role access as the other ops scripts (ops/shared/supabaseClient.js). See docs/SELF_HEALING.md.

const PAGE_SIZE = 1000;
const TABLE = "self_healing_shadow_events";
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const count = (rows, key) => rows.reduce((m, r) => ((m[r[key] ?? "none"] = (m[r[key] ?? "none"] ?? 0) + 1), m), {});
const percent = (part, whole) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

/** Reads every row since `since`, a page at a time. Throws the database error rather than hiding it. */
async function fetchRows(db, since) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from(TABLE)
      .select("created_at, mode, source, platform, error_class, legacy_action, legacy_delay_ms, new_action, new_delay_ms, new_reason_code, lateness_ms, would_alert, diverged")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function buildReport(rows) {
  const total = rows.length;
  const diverged = rows.filter((r) => r.diverged).length;

  const pairMap = new Map();
  for (const r of rows) {
    const key = `${r.legacy_action}|${r.new_action}`;
    const p = pairMap.get(key) ?? { legacy: r.legacy_action, next: r.new_action, count: 0, diverged: 0 };
    p.count += 1;
    if (r.diverged) p.diverged += 1;
    pairMap.set(key, p);
  }
  const pairs = [...pairMap.values()].sort((a, b) => b.count - a.count);

  const tooLateRows = rows.filter((r) => r.new_reason_code === "too_late");
  const atClaim = tooLateRows.filter((r) => r.legacy_action === "attempt");
  const atRetry = tooLateRows.filter((r) => r.legacy_action !== "attempt");

  return {
    total,
    byPlatform: count(rows, "platform"),
    byErrorClass: count(rows, "error_class"),
    byLegacyAction: count(rows, "legacy_action"),
    byNewAction: count(rows, "new_action"),
    diverged,
    divergedPercent: percent(diverged, total),
    pairs,
    tooLate: {
      total: tooLateRows.length,
      sharePercent: percent(tooLateRows.length, total),
      atClaim: atClaim.length,
      atRetry: atRetry.length,
      // A post that was NOT 2 hours late when it was claimed can never honestly be "too late": this must be 0.
      unexpectedAtClaim: atClaim.filter((r) => r.lateness_ms != null && r.lateness_ms <= TWO_HOURS_MS).length,
      // By design: the post was still on time, but the retry would have run past the 2 hour mark.
      retryUnderTwoHours: atRetry.filter((r) => r.lateness_ms != null && r.lateness_ms <= TWO_HOURS_MS).length,
    },
    wouldAlert: rows.filter((r) => r.would_alert).length,
  };
}

const table = (obj) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${k.padEnd(22)} ${v}`)
    .join("\n") || "  (none)";

function renderReport(r, opts = {}) {
  const days = opts.days ?? 7;
  const lines = [
    `Shadow report, last ${days} day(s): ${r.total} decision(s) recorded`,
    "",
    "By platform",
    table(r.byPlatform),
    "",
    "By error class",
    table(r.byErrorClass),
    "",
    "Old action (what the current logic did)",
    table(r.byLegacyAction),
    "",
    "New action (what the new policy would have done)",
    table(r.byNewAction),
    "",
    `Diverged: ${r.diverged} of ${r.total} (${r.divergedPercent} percent). By old action, then new action:`,
    ...(r.pairs.length ? r.pairs.map((p) => `  ${p.legacy.padEnd(16)} to ${p.next.padEnd(16)} ${String(p.count).padStart(6)} rows, ${p.diverged} diverged`) : ["  (none)"]),
    "",
    `Posts the new policy would have failed as too_late: ${r.tooLate.total} (${r.tooLate.sharePercent} percent of recorded decisions)`,
    `  at claim time:  ${r.tooLate.atClaim}   (unexpected, post was not 2 hours late: ${r.tooLate.unexpectedAtClaim}, this must be 0)`,
    `  at retry time:  ${r.tooLate.atRetry}   (of which the post was still on time when it failed: ${r.tooLate.retryUnderTwoHours}, by design)`,
    "",
    `Owner alerts that would have been sent: ${r.wouldAlert}`,
  ];
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const daysArg = args.indexOf("--days");
  const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 7;
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days needs a positive number");
  const { getSupabaseClient } = require("../shared/supabaseClient.js");
  const rows = await fetchRows(getSupabaseClient(), new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  const report = buildReport(rows);
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : renderReport(report, { days }));
}

module.exports = { buildReport, renderReport, fetchRows, PAGE_SIZE };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
