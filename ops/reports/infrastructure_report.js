#!/usr/bin/env node
// Weekly Infrastructure & Costs Report — real Render/Supabase costs, a live
// Health & Safety check run, and the storage revenue-vs-cost margin. Built
// 2026-08-05 after Werner asked to see this on paper, same way as
// weekly_report.js (Node + ExcelJS, not the Python/openpyxl one-off this
// mirrors — kept in the same runtime as everything else in ops/ so this
// runs unattended from a scheduled task with no separate toolchain).
//
// Run: node infrastructure_report.js [outputDir]
// Defaults to Desktop\Reports\LazyRelay\Infrastructure-Health-Reports\ if
// no outputDir is given.

const path = require("path");
const os = require("os");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { getSupabaseClient } = require("../shared/supabaseClient.js");
const { gatherStorageUsage, computeStorageMargin } = require("../shared/storageUsage.js");
const { checkStorageMargin } = require("../billing/billing_ops.js");
const { runAllChecks } = require("../health/health_ops.js");

// Fixed infra costs — mirrors SERVICE_PROVIDERS.md, confirmed live 2026-08-05.
const INFRA_COSTS_USD = [
  { provider: "Render", tier: "Starter (0.5 CPU / 512MB)", monthlyCost: 7.0, notes: "Confirmed live via Render billing. No free-tier spin-down." },
  { provider: "Supabase", tier: "Pro", monthlyCost: 25.0, notes: "Confirmed live via Supabase dashboard. 8GB disk / 100k MAU included." },
  { provider: "cPanel hosting", tier: "Shared (bundled)", monthlyCost: 0.0, notes: "Bundled with The Lazy Download's existing plan — no marginal cost." },
];

async function buildWorkbook(healthResult, marginResult, storageUsage, generatedAt) {
  const NAVY = "14171F";
  const ACCENT = "FF5630";
  const wb = new ExcelJS.Workbook();
  wb.creator = "LazyRelay Ops";
  wb.created = generatedAt;

  const ws = wb.addWorksheet("Infrastructure Report");
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const titleRow = ws.addRow([`LazyRelay — Infrastructure & Costs Report (snapshot: ${generatedAt.toISOString().slice(0, 10)})`]);
  ws.mergeCells(1, 1, 1, 4);
  titleRow.font = { name: "Arial", bold: true, size: 16, color: { argb: "FF" + NAVY } };

  const noteRow = ws.addRow(["Auto-generated weekly. Source: Render + Supabase billing (live), ops/health/run_health_check.js (live production run)."]);
  ws.mergeCells(noteRow.number, 1, noteRow.number, 4);
  noteRow.font = { name: "Arial", italic: true, size: 9, color: { argb: "FF5B6472" } };
  ws.addRow([]);

  const sectionHeader = (title) => {
    const r = ws.addRow([title]);
    ws.mergeCells(r.number, 1, r.number, 4);
    r.font = { name: "Arial", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
    r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + ACCENT } };
    return r;
  };
  const dataHeaderRow = (cells) => {
    const r = ws.addRow(cells);
    r.font = { name: "Arial", bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + NAVY } };
    return r;
  };

  // --- Infra costs ---
  sectionHeader("INFRASTRUCTURE COSTS");
  dataHeaderRow(["Provider", "Tier", "Monthly Cost (USD)", "Notes"]);
  const infraStartRow = ws.rowCount + 1;
  for (const item of INFRA_COSTS_USD) {
    const r = ws.addRow([item.provider, item.tier, item.monthlyCost, item.notes]);
    r.getCell(3).numberFormat = '$#,##0.00;($#,##0.00);"-"';
  }
  const infraEndRow = ws.rowCount;
  const infraTotalRow = ws.addRow(["Total monthly infra cost", "", { formula: `SUM(C${infraStartRow}:C${infraEndRow})` }]);
  infraTotalRow.font = { bold: true };
  infraTotalRow.getCell(3).numberFormat = '$#,##0.00;($#,##0.00);"-"';
  ws.addRow([]);

  // --- Health check ---
  sectionHeader(`HEALTH & SAFETY CHECK — this run: ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC (overall: ${healthResult.overall})`);
  dataHeaderRow(["Check", "Status", "Detail", ""]);
  for (const r of healthResult.results) {
    ws.addRow([r.check, r.status, r.detail]);
  }
  const healthNote = ws.addRow(["Thresholds documented in ops/health/HEALTH_KNOWLEDGE.md. The daily digest task only pings Slack when a check is warn/critical."]);
  ws.mergeCells(healthNote.number, 1, healthNote.number, 4);
  healthNote.font = { name: "Arial", italic: true, size: 9, color: { argb: "FF5B6472" } };
  ws.addRow([]);

  // --- Storage economics ---
  sectionHeader(`STORAGE ECONOMICS — real revenue vs real cost (status: ${marginResult.status})`);
  dataHeaderRow(["Metric", "Value", "Notes", ""]);
  const r1 = ws.addRow(["Active storage add-ons", marginResult.activeAddonCount, "Count of active/trialing storage_addons subscriptions"]);
  const r2 = ws.addRow(["Monthly storage revenue (USD)", marginResult.monthlyRevenueUsd, "Sum of active add-on prices ($2.99/5GB, $7.99/20GB, $14.99/50GB)"]);
  r2.getCell(2).numberFormat = '$#,##0.00;($#,##0.00);"-"';
  const r3 = ws.addRow(["Monthly storage cost (USD)", marginResult.monthlyCostUsd, "Supabase overage past the 100GB included allowance, at $0.021/GB"]);
  r3.getCell(2).numberFormat = '$#,##0.00;($#,##0.00);"-"';
  const marginRow = ws.addRow(["Margin (USD)", { formula: `B${r2.number}-B${r3.number}` }]);
  marginRow.font = { bold: true };
  marginRow.getCell(2).numberFormat = '$#,##0.00;($#,##0.00);"-"';
  ws.addRow(["Margin status", marginResult.status, marginResult.detail]);
  const marginNote = ws.addRow(["Alert thresholds (billing_ops.js::checkStorageMargin): WARN if revenue < 2x cost. CRITICAL if cost exceeds revenue. Never blocks a customer's storage — Supabase auto-scales, it only ever costs more."]);
  ws.mergeCells(marginNote.number, 1, marginNote.number, 4);
  marginNote.font = { name: "Arial", italic: true, size: 9, color: { argb: "FF5B6472" } };

  ws.columns = [{ width: 34 }, { width: 26 }, { width: 60 }, { width: 20 }];

  return wb;
}

async function main() {
  const outputDirArg = process.argv[2];
  const outputDir =
    outputDirArg || path.join(os.homedir(), "OneDrive", "Desktop", "Reports", "LazyRelay", "Infrastructure-Health-Reports");
  fs.mkdirSync(outputDir, { recursive: true });

  const supabase = getSupabaseClient();
  const generatedAt = new Date();

  const storageUsage = await gatherStorageUsage(supabase);
  const healthResult = await runAllChecks(supabase, storageUsage);
  const marginResult = await checkStorageMargin(supabase);

  const wb = await buildWorkbook(healthResult, marginResult, storageUsage, generatedAt);

  const filename = `LazyRelay_Infrastructure_Report_${generatedAt.toISOString().slice(0, 10)}.xlsx`;
  const outPath = path.join(outputDir, filename);
  await wb.xlsx.writeFile(outPath);

  console.log(
    JSON.stringify(
      {
        saved: outPath,
        healthOverall: healthResult.overall,
        storageMarginStatus: marginResult.status,
        totalInfraCostUsd: INFRA_COSTS_USD.reduce((s, i) => s + i.monthlyCost, 0),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
