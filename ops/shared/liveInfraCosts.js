// Reads LazyRelay's real Render + Supabase plan tiers live, so the weekly
// infrastructure/customer reports can never silently drift from what's
// actually being paid the way the hardcoded $32/mo figure did (Render was
// upgraded to Standard on 2026-09-05; the reports kept printing the old
// Starter/$7 price for weeks because nothing re-checked it). Falls back to
// the last-known-good hardcoded figures if either API call fails, so a
// transient outage degrades to "possibly stale" rather than crashing the
// report -- same honest-fallback discipline as billing_ops.js's Render env
// check.
const { getRenderCredentials, getSupabaseAccessToken } = require("../config/credentials.js");

const SUPABASE_ORG_ID = "ejubarwioyvlkadqgdyp";

const RENDER_PLAN_PRICES_USD = {
  free: 0,
  starter: 7,
  standard: 25,
  pro: 85,
  "pro plus": 175,
};

const SUPABASE_PLAN_PRICES_USD = {
  free: 0,
  pro: 25,
  team: 599,
};

const FALLBACK_COSTS = [
  { provider: "Render", tier: "Standard (2GB)", monthlyCost: 25.0, notes: "Fallback figure -- live Render check failed this run." },
  { provider: "Supabase", tier: "Pro", monthlyCost: 25.0, notes: "Fallback figure -- live Supabase check failed this run." },
  { provider: "cPanel hosting", tier: "Shared (bundled)", monthlyCost: 0.0, notes: "Bundled with The Lazy Download's existing plan -- no marginal cost." },
];

async function getRenderCost() {
  const creds = getRenderCredentials();
  if (!creds) return null;
  const res = await fetch(`https://api.render.com/v1/services/${creds.serviceId}`, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
  });
  if (!res.ok) throw new Error(`Render API returned ${res.status}`);
  const service = await res.json();
  const plan = (service.serviceDetails?.plan ?? service.plan ?? "").toLowerCase();
  const monthlyCost = RENDER_PLAN_PRICES_USD[plan];
  if (monthlyCost === undefined) throw new Error(`Unrecognized Render plan "${plan}" -- price table needs updating`);
  return { provider: "Render", tier: plan, monthlyCost, notes: `Live-read 2026-09-25 via GET /v1/services/{id} (plan: "${plan}").` };
}

async function getSupabaseCost() {
  const token = getSupabaseAccessToken();
  if (!token) return null;
  const res = await fetch(`https://api.supabase.com/v1/organizations/${SUPABASE_ORG_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Supabase API returned ${res.status}`);
  const org = await res.json();
  const plan = (org.plan ?? "").toLowerCase();
  const monthlyCost = SUPABASE_PLAN_PRICES_USD[plan];
  if (monthlyCost === undefined) throw new Error(`Unrecognized Supabase plan "${plan}" -- price table needs updating`);
  return { provider: "Supabase", tier: plan, monthlyCost, notes: `Live-read 2026-09-25 via GET /v1/organizations/{id} (plan: "${plan}").` };
}

/** Returns the same {provider, tier, monthlyCost, notes} shape both reports
 * already expect, live where possible. Each provider check fails
 * independently -- one API being down doesn't take the other down with it. */
async function getLiveInfraCosts() {
  const cPanel = { provider: "cPanel hosting", tier: "Shared (bundled)", monthlyCost: 0.0, notes: "Bundled with The Lazy Download's existing plan -- no marginal cost." };

  const [renderResult, supabaseResult] = await Promise.allSettled([getRenderCost(), getSupabaseCost()]);

  const render = renderResult.status === "fulfilled" && renderResult.value ? renderResult.value : FALLBACK_COSTS[0];
  const supabase = supabaseResult.status === "fulfilled" && supabaseResult.value ? supabaseResult.value : FALLBACK_COSTS[1];

  return [render, supabase, cPanel];
}

module.exports = { getLiveInfraCosts };
