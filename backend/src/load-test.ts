import "dotenv/config";
import { supabase } from "./supabase.js";

// Real throughput/latency load test against the DEPLOYED backend (Render) —
// distinct purpose from stress-test.ts, which checks correctness (race
// conditions, duplicate-post prevention) against the LOCAL backend. This
// one answers "how does the actual hosted service perform under sustained
// concurrent traffic" — checklist item #7 from the 2026-08-08 security
// audit (project-media-security-hardening-2026-07-24.md): no load test had
// ever been run against this API before this file existed.
//
// Safety: every request runs as a freshly-created, disposable test account
// (never real customer data), targets read-only GET routes only (never
// creates/schedules real posts, never touches AI endpoints — those cost
// real money per call and share the daily generation cap), and accounts
// are deleted at the end. Spreads load across multiple accounts because
// the rate limiter is per-account (60-600 req/min by tier) — hammering one
// account mostly just measures 429 rejection speed, not real capacity.

const API_URL = process.env.LOAD_TEST_URL ?? "https://lazyrelaylazyrelay-backend.onrender.com/api";
const NUM_ACCOUNTS = 8;
const SUSTAINED_DURATION_MS = 20_000;
const SUSTAINED_INTERVAL_MS = 400; // ~2.5 req/s/account/route -> ~5/s/account both routes -> ~40/s combined, well under free tier's 8x60/min=480/min=8/s per-account cap already, comfortable headroom

interface Sample {
  route: string;
  ms: number;
  status: number;
}

async function makeTestAccount(prefix: string): Promise<{ accountId: string; email: string; jwt: string }> {
  const email = `loadtest-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@lazyrelay.invalid`;
  const password = "LoadTest123!";
  const { data: user, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !user.user) throw error ?? new Error("no user");
  const accountId = user.user.id;

  // Self-cleaning on any failure past this point -- found live 2026-08-21:
  // a rate limit hitting the sign-in call below (not just createUser)
  // left a real orphaned auth user + accounts row that the caller's own
  // accountIds tracking never saw, since this function threw before
  // returning anything to add to that list. Every failure path from here
  // now deletes what was just created before re-throwing, so a caller
  // never has to reason about partial-creation orphans.
  try {
    await supabase.from("accounts").upsert({ id: accountId, email });

    const { createClient } = await import("@supabase/supabase-js");
    const authClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
    const { data: signIn, error: signInError } = await authClient.auth.signInWithPassword({ email, password });
    if (signInError || !signIn.session) throw signInError ?? new Error("no session");
    return { accountId, email, jwt: signIn.session.access_token };
  } catch (err) {
    await cleanup([accountId]);
    throw err;
  }
}

async function cleanup(accountIds: string[]) {
  for (const id of accountIds) {
    try {
      await supabase.from("accounts").delete().eq("id", id);
    } catch {
      // best-effort
    }
    try {
      await supabase.auth.admin.deleteUser(id);
    } catch {
      // best-effort
    }
  }
}

async function timedRequest(url: string, jwt: string): Promise<{ ms: number; status: number }> {
  const start = performance.now();
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
    // Drain the body so the connection is actually freed, same as a real client would.
    await res.text();
    return { ms: performance.now() - start, status: res.status };
  } catch {
    return { ms: performance.now() - start, status: 0 }; // 0 = network error/timeout, not an HTTP status
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function reportRoute(route: string, samples: Sample[]) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const ok = samples.filter((s) => s.status === 200).length;
  const limited = samples.filter((s) => s.status === 429).length;
  const errors = samples.filter((s) => s.status !== 200 && s.status !== 429).length;
  console.log(`\n  ${route}`);
  console.log(`    requests: ${samples.length} (${ok} ok, ${limited} rate-limited, ${errors} error)`);
  console.log(
    `    latency ms: mean=${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(0)} ` +
      `p50=${percentile(ms, 50).toFixed(0)} p95=${percentile(ms, 95).toFixed(0)} p99=${percentile(ms, 99).toFixed(0)} max=${ms[ms.length - 1]?.toFixed(0)}`,
  );
  if (errors > 0) {
    const statuses = [...new Set(samples.filter((s) => s.status !== 200 && s.status !== 429).map((s) => s.status))];
    console.log(`    non-200/429 statuses seen: ${statuses.join(", ")}`);
  }
}

async function fetchRenderCpuSnapshot(label: string) {
  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;
  if (!apiKey || !serviceId) return;
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 2 * 60 * 1000);
    const res = await fetch(
      `https://api.render.com/v1/metrics/cpu?resource=${serviceId}&startTime=${start.toISOString()}&endTime=${end.toISOString()}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const body = await res.json();
    const values = body?.[0]?.values ?? [];
    const last = values[values.length - 1]?.value;
    console.log(`  [Render CPU, ${label}] last sample: ${last !== undefined ? (last * 100).toFixed(1) + "%" : "unavailable"}`);
  } catch {
    console.log(`  [Render CPU, ${label}] unavailable`);
  }
}

// --- Phase A: sustained load across many accounts, real GET routes only ---
async function sustainedLoadPhase(accounts: { accountId: string; jwt: string }[]): Promise<Sample[]> {
  console.log(`\n=== Phase A: sustained load, ${accounts.length} accounts, ${SUSTAINED_DURATION_MS / 1000}s ===`);
  const samples: Sample[] = [];
  const deadline = Date.now() + SUSTAINED_DURATION_MS;

  const workers = accounts.map(async ({ jwt }) => {
    while (Date.now() < deadline) {
      const [a, b] = await Promise.all([
        timedRequest(`${API_URL}/scheduled-posts`, jwt).then((r) => ({ route: "GET /scheduled-posts", ...r })),
        timedRequest(`${API_URL}/analytics/summary`, jwt).then((r) => ({ route: "GET /analytics/summary", ...r })),
      ]);
      samples.push(a, b);
      await new Promise((r) => setTimeout(r, SUSTAINED_INTERVAL_MS));
    }
  });

  await Promise.all(workers);
  return samples;
}

// --- Phase B: burst on one account, confirms the rate limiter still holds under real concurrency ---
async function burstPhase(jwt: string): Promise<Sample[]> {
  console.log("\n=== Phase B: burst on a single account (confirms rate limiter holds) ===");
  const requests = Array.from({ length: 80 }, () =>
    timedRequest(`${API_URL}/scheduled-posts`, jwt).then((r) => ({ route: "GET /scheduled-posts (burst)", ...r })),
  );
  return Promise.all(requests);
}

// --- Ramp mode: push concurrency 5 -> 150 in stages, one round of
// concurrent GET /scheduled-posts + GET /analytics/summary per account per
// stage. Real finding from running this 2026-08-21: this stage shape fires
// every account's request at the exact same instant, which queues up
// behind Render's single 0.5 CPU instance and shows meaningfully HIGHER
// latency (p50 ~1.7-2.5s here) than the sustainedLoadPhase below measured
// at comparable volume on the same day (p50 ~950-960ms, matching the
// 2026-07-29 baseline in project-infra-upgrade-load-test-2026-07-29.md,
// ~800-1250ms) -- confirmed live by re-running sustainedLoadPhase
// immediately after and getting numbers back in the original range. This
// mode's latency is a worst-case synchronized-burst number (nobody's real
// traffic arrives in perfect unison), useful for finding a real error-rate
// ceiling, NOT a reliable proxy for typical customer-facing latency at
// that concurrency -- use sustainedLoadPhase (LOAD_TEST_MODE=sustained)
// for that question instead. Creates all accounts needed for the largest
// stage up front (Supabase
// Auth's own admin-createUser rate limit is the thing that capped the
// July run around 169, not Render capacity) and reuses subsets per stage,
// rather than re-creating accounts at every stage.
const RAMP_STAGES = [5, 10, 20, 40, 60, 80, 100, 150];

async function rampPhase(): Promise<{ accountIds: string[] }> {
  const maxAccounts = RAMP_STAGES[RAMP_STAGES.length - 1];
  console.log(`\n=== Creating up to ${maxAccounts} disposable test accounts for the ramp ===`);
  const accounts: { accountId: string; jwt: string }[] = [];
  const accountIds: string[] = [];
  for (let i = 0; i < maxAccounts; i++) {
    try {
      const account = await makeTestAccount(`ramp-${i}`);
      accounts.push(account);
      accountIds.push(account.accountId);
    } catch (err) {
      console.log(
        `  Account creation stopped at ${accounts.length}/${maxAccounts} -- ${err instanceof Error ? err.message : String(err)} ` +
          `(matches the July finding: Supabase Auth's own signup rate limit, not Render capacity)`,
      );
      break;
    }
  }
  console.log(`  Created ${accounts.length} accounts.`);

  for (const stage of RAMP_STAGES) {
    if (stage > accounts.length) {
      console.log(`\n=== Stage ${stage} skipped -- only ${accounts.length} accounts available ===`);
      continue;
    }
    const stageAccounts = accounts.slice(0, stage);
    console.log(`\n=== Stage: ${stage} concurrent accounts, one round each ===`);
    const samples = (
      await Promise.all(
        stageAccounts.map(async ({ jwt }) => {
          const [a, b] = await Promise.all([
            timedRequest(`${API_URL}/scheduled-posts`, jwt).then((r) => ({ route: "GET /scheduled-posts", ...r })),
            timedRequest(`${API_URL}/analytics/summary`, jwt).then((r) => ({ route: "GET /analytics/summary", ...r })),
          ]);
          return [a, b];
        }),
      )
    ).flat();

    const ok = samples.filter((s) => s.status === 200).length;
    const errors = samples.filter((s) => s.status !== 200 && s.status !== 429).length;
    const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
    console.log(
      `  ${samples.length} requests: ${ok} ok, ${errors} error(s). ` +
        `latency ms: p50=${percentile(ms, 50).toFixed(0)} p95=${percentile(ms, 95).toFixed(0)} p99=${percentile(ms, 99).toFixed(0)} max=${ms[ms.length - 1]?.toFixed(0)}`,
    );
    if (errors > 0) {
      const statuses = [...new Set(samples.filter((s) => s.status !== 200 && s.status !== 429).map((s) => s.status))];
      console.log(`  non-200 statuses seen: ${statuses.join(", ")}`);
    }
    await fetchRenderCpuSnapshot(`after stage ${stage}`);
  }

  return { accountIds };
}

async function main() {
  console.log(`=== LazyRelay load test — target: ${API_URL} ===`);
  const mode = process.env.LOAD_TEST_MODE ?? "ramp";
  const accountIds: string[] = [];

  try {
    await fetchRenderCpuSnapshot("before");

    if (mode === "ramp") {
      const result = await rampPhase();
      accountIds.push(...result.accountIds);
    } else {
      console.log(`\nCreating ${NUM_ACCOUNTS} disposable test accounts...`);
      const accounts = await Promise.all(Array.from({ length: NUM_ACCOUNTS }, (_, i) => makeTestAccount(`sustained-${i}`)));
      accountIds.push(...accounts.map((a) => a.accountId));

      const sustainedSamples = await sustainedLoadPhase(accounts);
      await fetchRenderCpuSnapshot("during/after sustained phase");

      const burstSamples = await burstPhase(accounts[0].jwt);

      console.log("\n=== Results ===");
      reportRoute("GET /scheduled-posts (sustained)", sustainedSamples.filter((s) => s.route === "GET /scheduled-posts"));
      reportRoute("GET /analytics/summary (sustained)", sustainedSamples.filter((s) => s.route === "GET /analytics/summary"));
      reportRoute("GET /scheduled-posts (burst, 80 reqs/1 account)", burstSamples);

      const burstLimited = burstSamples.filter((s) => s.status === 429).length;
      const burstOk = burstSamples.filter((s) => s.status === 200).length;
      console.log(
        `\nRate limiter check: ${burstLimited > 0 && burstOk > 0 ? "PASS" : "FAIL"} — ` +
          `${burstOk} ok, ${burstLimited} rate-limited out of 80 rapid requests on one account`,
      );
    }

    await fetchRenderCpuSnapshot("final");
  } finally {
    console.log(`\nCleaning up ${accountIds.length} test account(s)...`);
    await cleanup(accountIds);
    console.log("Done.");
  }
}

main().catch((err) => {
  console.error("Load test crashed:", err);
  process.exit(1);
});
