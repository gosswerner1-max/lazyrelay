#!/usr/bin/env node
// Weekly Customer Report — real Supabase data (accounts, subscriptions,
// social_accounts, storage_addons, scheduled_posts), plus the fixed
// infrastructure-cost figures from the one-off launch-cost analysis
// (memory: SERVICE_PROVIDERS.md / LazyRelay_Launch_Cost.xlsx).
//
// Run: node weekly_report.js [outputDir]
// Defaults to Desktop\Reports\LazyRelay\Weekly-Customer-Reports\ if no
// outputDir is given, so the same command works unattended from a
// scheduled task once real customers exist.
//
// Everything here queries the REAL tables — no invented numbers. Pre-launch
// (no real Paddle production data yet) this will legitimately show zeros
// for revenue/MRR; that's correct, not a bug. See getMorStatus() in
// billing_ops.js for the sandbox/production distinction this report
// respects the same way.

const path = require("path");
const os = require("os");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { getSupabaseClient } = require("../shared/supabaseClient.js");
const { getMorStatus } = require("../billing/billing_ops.js");
const { gatherStorageUsage } = require("../shared/storageUsage.js");

// Real pricing constants — mirrored from frontend/src/pages/Landing.tsx
// (subscription tiers) and Dashboard.tsx (storage add-ons). Kept here
// rather than imported cross-runtime (ops/ is CommonJS, frontend is a
// separate Vite/TS build) — same boundary reasoning as accountLimits.ts
// needing its own copy in backend/src vs ops/.
const TIER_PRICE_USD = { free: 0, pro: 24.99, business: 48.99, enterprise: 79.99 };
const TIER_DISPLAY_NAMES = { free: "Free", pro: "Starter", business: "Pro", enterprise: "Business" };
const STORAGE_ADDON_PRICE_USD = { 5: 2.99, 20: 7.99, 50: 14.99 };

const WEEK_MS = 7 * 24 * 3600 * 1000;

function weekWindow(now = new Date()) {
  const end = now;
  const start = new Date(end.getTime() - WEEK_MS);
  return { start, end };
}

async function gatherAccountsAndRevenue(supabase) {
  const { data: accounts, error: accountsError } = await supabase
    .from("accounts")
    .select("id, email, created_at, cancelled_at");
  if (accountsError) throw accountsError;

  const { data: subscriptions, error: subsError } = await supabase
    .from("subscriptions")
    .select("account_id, tier, status, current_period_end, updated_at");
  if (subsError) throw subsError;

  const { data: addons, error: addonsError } = await supabase
    .from("storage_addons")
    .select("account_id, gb_amount, status");
  if (addonsError) throw addonsError;

  const subByAccount = new Map((subscriptions ?? []).map((s) => [s.account_id, s]));

  const { start, end } = weekWindow();
  const totalCustomers = (accounts ?? []).filter((a) => !a.cancelled_at).length;
  const newThisWeek = (accounts ?? []).filter(
    (a) => new Date(a.created_at) >= start && new Date(a.created_at) <= end
  ).length;
  const cancelledThisWeek = (accounts ?? []).filter(
    (a) => a.cancelled_at && new Date(a.cancelled_at) >= start && new Date(a.cancelled_at) <= end
  ).length;

  const tierCounts = { free: 0, pro: 0, business: 0, enterprise: 0 };
  let mrr = 0;
  for (const account of accounts ?? []) {
    if (account.cancelled_at) continue;
    const sub = subByAccount.get(account.id);
    const isPaidActive = sub && sub.tier !== "free" && (sub.status === "active" || sub.status === "trialing");
    const tier = isPaidActive ? sub.tier : "free";
    tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
    if (isPaidActive) mrr += TIER_PRICE_USD[tier] ?? 0;
  }

  let addonMrr = 0;
  const activeAddons = (addons ?? []).filter((a) => a.status === "active");
  for (const a of activeAddons) {
    addonMrr += STORAGE_ADDON_PRICE_USD[a.gb_amount] ?? 0;
  }

  // Churn = cancellations this week / customers who existed at the start of the week
  const customersAtWeekStart = (accounts ?? []).filter(
    (a) => new Date(a.created_at) < start && (!a.cancelled_at || new Date(a.cancelled_at) >= start)
  ).length;
  const churnRate = customersAtWeekStart > 0 ? cancelledThisWeek / customersAtWeekStart : 0;

  return {
    totalCustomers,
    newThisWeek,
    cancelledThisWeek,
    churnRate,
    tierCounts,
    mrr,
    addonMrr,
    activeAddonCount: activeAddons.length,
    weekStart: start,
    weekEnd: end,
  };
}

async function gatherPlatformActivity(supabase, weekStart, weekEnd) {
  const { data: socialAccounts, error: saError } = await supabase
    .from("social_accounts")
    .select("id, platform, connected_at, disconnected_at, paused_at");
  if (saError) throw saError;

  const platformBySocialAccountId = new Map((socialAccounts ?? []).map((sa) => [sa.id, sa.platform]));

  const connectedByPlatform = {};
  for (const sa of socialAccounts ?? []) {
    if (sa.disconnected_at) continue;
    connectedByPlatform[sa.platform] = (connectedByPlatform[sa.platform] ?? 0) + 1;
  }

  // scheduled_posts has no separate "posted at" timestamp — status='posted'
  // rows within this week's scheduled_for window are the closest real proxy
  // the schema supports (no invented column).
  const { data: posts, error: postsError } = await supabase
    .from("scheduled_posts")
    .select("social_account_id, status, scheduled_for")
    .gte("scheduled_for", weekStart.toISOString())
    .lte("scheduled_for", weekEnd.toISOString())
    .eq("status", "posted");
  if (postsError) throw postsError;

  const postsByPlatform = {};
  for (const p of posts ?? []) {
    const platform = platformBySocialAccountId.get(p.social_account_id) ?? "unknown";
    postsByPlatform[platform] = (postsByPlatform[platform] ?? 0) + 1;
  }

  const platforms = new Set([...Object.keys(connectedByPlatform), ...Object.keys(postsByPlatform)]);
  return Array.from(platforms)
    .sort()
    .map((platform) => ({
      platform,
      connectedAccounts: connectedByPlatform[platform] ?? 0,
      postsThisWeek: postsByPlatform[platform] ?? 0,
    }));
}

// Fixed infra costs — mirrors SERVICE_PROVIDERS.md / LazyRelay_Launch_Cost.xlsx.
// Kept as plain data here so this report always shows the same cost side
// by side with the revenue side, without re-deriving it each week.
const INFRA_COSTS_USD = [
  { provider: "Render (backend hosting)", tierNeeded: "Starter (no spin-down)", monthlyCost: 7 },
  { provider: "Supabase (DB/auth/vault)", tierNeeded: "Pro (8GB/100k MAU)", monthlyCost: 25 },
  { provider: "cPanel hosting (frontend+email)", tierNeeded: "Bundled, no change", monthlyCost: 0 },
  { provider: "Let's Encrypt SSL", tierNeeded: "Free, no change", monthlyCost: 0 },
  { provider: "Google Analytics 4", tierNeeded: "Free, no change", monthlyCost: 0 },
  { provider: "Slack (ops alerting)", tierNeeded: "Free, no change", monthlyCost: 0 },
  { provider: "Roundcube / IMAP-SMTP", tierNeeded: "Bundled, no change", monthlyCost: 0 },
];

async function buildWorkbook(summary, platformActivity, morStatus, storageUsage) {
  const NAVY = "14171F";
  const ACCENT = "FF5630";
  const wb = new ExcelJS.Workbook();
  wb.creator = "LazyRelay Ops";
  wb.created = summary.weekEnd;

  const ws = wb.addWorksheet("Weekly Report");
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const titleRow = ws.addRow([
    `LazyRelay — Weekly Customer Report (${summary.weekStart.toISOString().slice(0, 10)} to ${summary.weekEnd
      .toISOString()
      .slice(0, 10)})`,
  ]);
  ws.mergeCells(1, 1, 1, 6);
  titleRow.font = { name: "Arial", bold: true, size: 16, color: { argb: "FF" + NAVY } };

  if (morStatus.environment !== "production") {
    const warnRow = ws.addRow([
      `⚠ Billing is in ${morStatus.environment.toUpperCase()} mode — revenue/MRR figures below are NOT real customer money.`,
    ]);
    ws.mergeCells(warnRow.number, 1, warnRow.number, 6);
    warnRow.font = { name: "Arial", bold: true, size: 11, color: { argb: "FFCC0000" } };
  }

  ws.addRow([]);

  // --- Customer summary ---
  const sectionHeader = (title) => {
    const r = ws.addRow([title]);
    ws.mergeCells(r.number, 1, r.number, 6);
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

  sectionHeader("CUSTOMERS");
  dataHeaderRow(["Metric", "Value", "", "", "", ""]);
  const metricRow = (label, value, isCurrency = false, isPercent = false) => {
    const r = ws.addRow([label, value]);
    if (isCurrency) r.getCell(2).numberFormat = '$#,##0.00;($#,##0.00);"-"';
    if (isPercent) r.getCell(2).numberFormat = "0.0%";
    return r;
  };
  metricRow("Total active customers", summary.totalCustomers);
  metricRow("New this week", summary.newThisWeek);
  metricRow("Cancelled this week", summary.cancelledThisWeek);
  metricRow("Churn rate (this week)", summary.churnRate, false, true);
  ws.addRow([]);

  dataHeaderRow(["Tier", "Customer count", "Price/mo (USD)", "Subtotal MRR (USD)", "", ""]);
  const tierStartRow = ws.rowCount + 1;
  for (const tier of ["free", "pro", "business", "enterprise"]) {
    const count = summary.tierCounts[tier] ?? 0;
    const price = TIER_PRICE_USD[tier];
    const r = ws.addRow([TIER_DISPLAY_NAMES[tier], count, price, { formula: `B${ws.rowCount + 1}*C${ws.rowCount + 1}` }]);
    r.getCell(3).numberFormat = '$#,##0.00;($#,##0.00);"-"';
    r.getCell(4).numberFormat = '$#,##0.00;($#,##0.00);"-"';
  }
  const tierEndRow = ws.rowCount;
  const mrrRow = ws.addRow(["Subscription MRR", "", "", { formula: `SUM(D${tierStartRow}:D${tierEndRow})` }]);
  mrrRow.font = { bold: true };
  mrrRow.getCell(4).numberFormat = '$#,##0.00;($#,##0.00);"-"';
  const addonRow = ws.addRow(["Storage add-on MRR", summary.activeAddonCount, "", summary.addonMrr]);
  addonRow.getCell(4).numberFormat = '$#,##0.00;($#,##0.00);"-"';
  const totalMrrRow = ws.addRow(["TOTAL MRR", "", "", { formula: `D${mrrRow.number}+D${addonRow.number}` }]);
  totalMrrRow.font = { bold: true, size: 11 };
  totalMrrRow.getCell(4).numberFormat = '$#,##0.00;($#,##0.00);"-"';
  ws.addRow([]);

  // --- Platform activity ---
  sectionHeader("PLATFORM ACTIVITY (this week)");
  dataHeaderRow(["Platform", "Connected accounts", "Posts published this week", "", "", ""]);
  if (platformActivity.length === 0) {
    ws.addRow(["(no connected accounts or posts yet)", "", ""]);
  } else {
    for (const p of platformActivity) {
      ws.addRow([p.platform, p.connectedAccounts, p.postsThisWeek]);
    }
  }
  ws.addRow([]);

  // --- Infra costs ---
  sectionHeader("INFRASTRUCTURE COST (fixed monthly, if on launch-ready tiers)");
  dataHeaderRow(["Provider", "Tier needed", "Monthly cost (USD)", "", "", ""]);
  const infraStartRow = ws.rowCount + 1;
  for (const item of INFRA_COSTS_USD) {
    const r = ws.addRow([item.provider, item.tierNeeded, item.monthlyCost]);
    r.getCell(3).numberFormat = '$#,##0;($#,##0);"-"';
  }
  const infraEndRow = ws.rowCount;
  const infraTotalRow = ws.addRow(["TOTAL FIXED INFRA COST", "", { formula: `SUM(C${infraStartRow}:C${infraEndRow})` }]);
  infraTotalRow.font = { bold: true };
  infraTotalRow.getCell(3).numberFormat = '$#,##0;($#,##0);"-"';
  ws.addRow([]);

  // --- Supabase media storage overage ---
  // This is the one infra cost that actually scales with customer count —
  // Render/Supabase's own compute+DB tiers are flat until you outgrow them
  // (see SERVICE_PROVIDERS.md), but customer-uploaded media directly grows
  // Supabase Storage usage, which is metered beyond the Pro plan's included
  // 100GB. Tracked separately from INFRA_COSTS_USD (which is fixed) so the
  // report is honest about which cost is flat and which one moves.
  sectionHeader("SUPABASE MEDIA STORAGE (usage-based — scales with customers)");
  dataHeaderRow(["Metric", "Value", "", "", "", ""]);
  const storageRows = {
    total: ws.addRow(["Total media storage used (GB)", storageUsage.totalGb]),
    included: ws.addRow(["Included in Pro plan (GB)", storageUsage.includedGb]),
    overageGb: ws.addRow(["Overage (GB)", storageUsage.overageGb]),
    overageCost: ws.addRow(["Overage cost (USD/mo)", storageUsage.overageCostUsd]),
  };
  storageRows.total.getCell(2).numberFormat = "0.00";
  storageRows.included.getCell(2).numberFormat = "0";
  storageRows.overageGb.getCell(2).numberFormat = "0.00";
  storageRows.overageCost.getCell(2).numberFormat = '$#,##0.00;($#,##0.00);"-"';
  storageRows.overageCost.font = { bold: true };
  ws.addRow([]);

  // --- Net ---
  sectionHeader("NET (MRR minus fixed infra cost minus storage overage)");
  const netRow = ws.addRow([
    "Net monthly (MRR − infra − storage overage)",
    { formula: `D${totalMrrRow.number}-C${infraTotalRow.number}-B${storageRows.overageCost.number}` },
  ]);
  netRow.font = { bold: true, size: 11 };
  netRow.getCell(2).numberFormat = '$#,##0.00;($#,##0.00);"-"';

  ws.columns = [{ width: 32 }, { width: 20 }, { width: 20 }, { width: 22 }, { width: 12 }, { width: 12 }];

  return wb;
}

async function main() {
  const outputDirArg = process.argv[2];
  const outputDir =
    outputDirArg ||
    path.join(os.homedir(), "OneDrive", "Desktop", "Reports", "LazyRelay", "Weekly-Customer-Reports");
  fs.mkdirSync(outputDir, { recursive: true });

  const supabase = getSupabaseClient();
  const morStatus = getMorStatus();

  const summary = await gatherAccountsAndRevenue(supabase);
  const platformActivity = await gatherPlatformActivity(supabase, summary.weekStart, summary.weekEnd);
  const storageUsage = await gatherStorageUsage(supabase);

  const wb = await buildWorkbook(summary, platformActivity, morStatus, storageUsage);

  const filename = `LazyRelay_Weekly_Report_${summary.weekEnd.toISOString().slice(0, 10)}.xlsx`;
  const outPath = path.join(outputDir, filename);
  await wb.xlsx.writeFile(outPath);

  console.log(
    JSON.stringify(
      {
        saved: outPath,
        totalCustomers: summary.totalCustomers,
        newThisWeek: summary.newThisWeek,
        cancelledThisWeek: summary.cancelledThisWeek,
        mrr: summary.mrr,
        billingEnvironment: morStatus.environment,
        storageUsedGb: Number(storageUsage.totalGb.toFixed(2)),
        storageOverageCostUsd: Number(storageUsage.overageCostUsd.toFixed(2)),
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
