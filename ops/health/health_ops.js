// Health & Safety Operator — independent, OUTSIDE-vantage-point monitoring
// of the live LazyRelay system (backend, frontend, SSL, scheduler lag,
// storage). Distinct from the scheduler's own in-process circuit breaker
// (backend/src/scheduler.ts), which only ever sees platform-API failures
// from inside the running process and can't tell you if the process itself
// is asleep/unreachable. See HEALTH_KNOWLEDGE.md for the full threshold
// table and design boundary (report-only — never restarts/upgrades/spends
// money automatically).

const tls = require("tls");

const BACKEND_HEALTH_URL = "https://lazyrelaylazyrelay-backend.onrender.com/health";
const FRONTEND_URL = "https://lazyrelay.com";
const SSL_CHECK_HOST = "lazyrelay.com";

const THRESHOLDS = {
  backendLatencyWarnMs: 3000,
  backendLatencyCriticalMs: 10000,
  sslDaysWarn: 14,
  sslDaysCritical: 7,
  overduePostsWarn: 1,
  overduePostsCritical: 5,
  // Supabase Pro plan (confirmed live 2026-08-05): 8GB disk included,
  // 100k MAU included. Both auto-scale/meter past the included amount
  // rather than hard-blocking (confirmed on the Supabase usage page) — so
  // these are early-warning thresholds, not "about to break" thresholds.
  dbSizeWarnGb: 6,
  dbSizeCriticalGb: 8,
  mauWarnCount: 80000,
  mauCriticalCount: 100000,
};

function severity(value, warnAt, criticalAt, higherIsWorse = true) {
  if (higherIsWorse) {
    if (value >= criticalAt) return "critical";
    if (value >= warnAt) return "warn";
    return "ok";
  }
  if (value <= criticalAt) return "critical";
  if (value <= warnAt) return "warn";
  return "ok";
}

async function checkBackendHealth() {
  const start = Date.now();
  try {
    // NOTE (2026-08-05): this 60s window was originally sized for Render's
    // free-tier cold-start delay (~50s). Render is now on Starter (confirmed
    // live, no spin-down) — this timeout is stale and could delay detecting
    // a real outage by up to a minute. Left as-is pending a decision on the
    // new value; see HEALTH_KNOWLEDGE.md.
    const res = await fetch(BACKEND_HEALTH_URL, { signal: AbortSignal.timeout(60000) });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { check: "backend_health", status: "critical", detail: `Non-200 response: ${res.status}`, latencyMs };
    }
    return {
      check: "backend_health",
      status: severity(latencyMs, THRESHOLDS.backendLatencyWarnMs, THRESHOLDS.backendLatencyCriticalMs),
      detail: `Responded in ${latencyMs}ms`,
      latencyMs,
    };
  } catch (err) {
    return { check: "backend_health", status: "critical", detail: `Unreachable: ${err.message}`, latencyMs: null };
  }
}

async function checkFrontendUp() {
  try {
    const res = await fetch(FRONTEND_URL, { signal: AbortSignal.timeout(30000) });
    return {
      check: "frontend_up",
      status: res.ok ? "ok" : "critical",
      detail: res.ok ? `${res.status} OK` : `Non-200 response: ${res.status}`,
    };
  } catch (err) {
    return { check: "frontend_up", status: "critical", detail: `Unreachable: ${err.message}` };
  }
}

function checkSslExpiry(host = SSL_CHECK_HOST) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host, port: 443, servername: host, timeout: 15000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          resolve({ check: "ssl_expiry", status: "critical", detail: "Could not read certificate" });
          return;
        }
        const daysRemaining = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / (24 * 3600 * 1000));
        resolve({
          check: "ssl_expiry",
          status: severity(daysRemaining, THRESHOLDS.sslDaysWarn, THRESHOLDS.sslDaysCritical, false),
          detail: `${daysRemaining} days remaining (expires ${cert.valid_to})`,
          daysRemaining,
        });
      }
    );
    socket.on("error", (err) => {
      resolve({ check: "ssl_expiry", status: "critical", detail: `Connection error: ${err.message}` });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ check: "ssl_expiry", status: "critical", detail: "Connection timed out" });
    });
  });
}

/** Real Supabase read: posts still 'pending' well past their scheduled_for
 *  time is the most direct externally-observable proxy for "the scheduler
 *  is falling behind" — the in-process circuit breaker state isn't visible
 *  from here since it lives only in the running backend's memory. */
async function checkSchedulerLag(supabase, graceMinutes = 5) {
  const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("scheduled_posts")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .is("paused_at", null)
    .lt("scheduled_for", cutoff);
  if (error) throw error;
  const overdueCount = count ?? 0;
  return {
    check: "scheduler_lag",
    status: severity(overdueCount, THRESHOLDS.overduePostsWarn, THRESHOLDS.overduePostsCritical),
    detail: `${overdueCount} post(s) still pending more than ${graceMinutes} minutes past their scheduled time`,
    overdueCount,
  };
}

// NOTE (2026-08-05): storage overage is deliberately EXCLUDED from the
// overall health severity (see runAllChecks) — Supabase meters/auto-scales
// past the included amount rather than hard-blocking, so this is never an
// operational emergency. It's reported for visibility only; the real
// dollar-vs-revenue question lives in billing_ops.js::checkStorageMargin,
// since margin is a pricing decision, not a site-down signal.
async function checkStorageOverage(storageUsage) {
  const status = storageUsage.overageGb > 0 ? "warn" : "ok";
  return {
    check: "storage_overage",
    status,
    detail: `${storageUsage.overageGb.toFixed(2)}GB over the included 100GB (~$${storageUsage.overageCostUsd.toFixed(2)}/mo) — informational only, never a Slack trigger; see billing margin check for the real signal`,
    excludeFromOverall: true,
  };
}

/** Real DB disk size via the ops_db_size_bytes() RPC (migration 0031).
 *  Proxy for the dashboard's "Disk Size" figure, not pixel-identical (real
 *  billing includes some overhead beyond just the database itself), but
 *  close enough to alert well before the real 8GB included cap. */
async function checkDatabaseSize(supabase) {
  const { data, error } = await supabase.rpc("ops_db_size_bytes");
  if (error) throw error;
  const gb = Number(data) / (1024 * 1024 * 1024);
  return {
    check: "db_size",
    status: severity(gb, THRESHOLDS.dbSizeWarnGb, THRESHOLDS.dbSizeCriticalGb),
    detail: `${gb.toFixed(2)}GB of 8GB included (Pro plan) — auto-scales past this, not a hard block`,
    gb,
  };
}

/** Real MAU via the ops_monthly_active_users() RPC (migration 0031),
 *  windowed to the current calendar month as a stand-in for Supabase's
 *  actual billing-cycle boundary (not read from Supabase directly — this
 *  is a proxy, and a conservative one: see the RPC's own comment). */
async function checkMonthlyActiveUsers(supabase) {
  const cycleStart = new Date();
  cycleStart.setUTCDate(1);
  cycleStart.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase.rpc("ops_monthly_active_users", { cycle_start: cycleStart.toISOString() });
  if (error) throw error;
  const count = Number(data);
  return {
    check: "monthly_active_users",
    status: severity(count, THRESHOLDS.mauWarnCount, THRESHOLDS.mauCriticalCount),
    detail: `${count} MAU (proxy: distinct sign-ins since ${cycleStart.toISOString().slice(0, 10)}) of 100k included (Pro plan) — real billed figure may run slightly higher, this proxy never overstates`,
    count,
  };
}

/** Runs every check and returns a flat results array plus an overall
 *  worst-case status ("ok" | "warn" | "critical"), so a caller can decide
 *  whether to alert without re-deriving the severity logic. */
async function runAllChecks(supabase, storageUsage) {
  const results = await Promise.all([
    checkBackendHealth(),
    checkFrontendUp(),
    checkSslExpiry(),
    checkSchedulerLag(supabase),
    checkStorageOverage(storageUsage),
    checkDatabaseSize(supabase),
    checkMonthlyActiveUsers(supabase),
  ]);
  const rank = { ok: 0, warn: 1, critical: 2 };
  const overall = results
    .filter((r) => !r.excludeFromOverall)
    .reduce((worst, r) => (rank[r.status] > rank[worst] ? r.status : worst), "ok");
  return { overall, results };
}

module.exports = {
  THRESHOLDS,
  checkBackendHealth,
  checkFrontendUp,
  checkSslExpiry,
  checkSchedulerLag,
  checkStorageOverage,
  checkDatabaseSize,
  checkMonthlyActiveUsers,
  runAllChecks,
};
