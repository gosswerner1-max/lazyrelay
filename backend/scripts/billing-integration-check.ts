// Real-database integration check of the LazyCredits billing wiring (wallet service, publish gate/scheduler, Paddle webhook path,
// teardown route). It drives the REAL backend code against a THROWAWAY Supabase branch. Fakes: the platform adapter, the competitor engine
// (a localhost HTTP server) and the Paddle webhook payloads (signed with a test secret and parsed by the real PaddleMorAdapter).
//
// HOW TO RUN (from the backend folder; about 3 minutes)
//   1. Create a throwaway Supabase branch of the project (never use production) and apply migrations 0139 to 0142 to it.
//      If the branch has no wallet tables, run this script once with BILLING_IT_APPLY_MIGRATIONS=yes (applies 0139..0142 to the branch only).
//      NOTE: a fresh Supabase branch replays only the migration HISTORY (0001-0091, 0128-0133, 0135, 0137), not the migrations applied to
//      production by hand. Before this script is meaningful the branch also needs 0092-0127 (except 0119, which the branch already has), 0134,
//      0136, 0138, then 0139-0142. Without them the scheduler cannot even read scheduled_posts.media_urls.
//   2. Set:   BILLING_IT_BRANCH_REF=<branch project ref>      BILLING_IT_I_AM_A_THROWAWAY_BRANCH=yes
//             SUPABASE_ACCESS_TOKEN=<management token>   (or BILLING_IT_CREDENTIALS_FILE=<json file with "supabaseAccessToken">)
//      The script asks the Management API for the branch keys itself. Nothing secret is printed.
//   3. NODE_PATH is not used: run with   npx tsx scripts/billing-integration-check.ts
//   4. Read the PASS/FAIL table. Exit code 0 only when every scenario passed. Then delete the branch.
//
// SAFETY. The script refuses to run unless the ref is a NON-default branch of the production project and the flag above is "yes". It
// overwrites every SUPABASE_*, PADDLE_*, SLACK_*, RESEND_* and CONTENT_SOURCES_* variable before any backend code is loaded, so the
// backend can only ever talk to the branch. No real Paddle call, no real post, no real engine call is made.
import fs from "node:fs";
import http from "node:http";
import { createPublicKey, generateKeyPairSync, randomBytes, verify as cryptoVerify } from "node:crypto";
import type { AddressInfo } from "node:net";

const PROD_REF = "qbmejnmyqogotdzzzyvj";
const MGMT = "https://api.supabase.com/v1";
const REF = process.env.BILLING_IT_BRANCH_REF ?? "";
const secrets: string[] = [];
const out = (line: string) => process.stdout.write(`${scrub(line)}\n`);
function scrub(text: string): string {
  let t = String(text);
  for (const s of secrets) if (s && s.length > 8) t = t.split(s).join("[hidden]");
  return t;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Guard, keys, environment. All of this happens BEFORE a single backend module is imported.
// ---------------------------------------------------------------------------------------------------------------------------------
if (process.env.BILLING_IT_I_AM_A_THROWAWAY_BRANCH !== "yes") throw new Error('REFUSED: BILLING_IT_I_AM_A_THROWAWAY_BRANCH must be exactly "yes"');
if (!/^[a-z]{20}$/.test(REF)) throw new Error("REFUSED: BILLING_IT_BRANCH_REF is missing or not a project ref");
if (REF === PROD_REF) throw new Error("REFUSED: that is the production project");

function managementToken(): string {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  const file = process.env.BILLING_IT_CREDENTIALS_FILE;
  if (!file) throw new Error("REFUSED: set SUPABASE_ACCESS_TOKEN or BILLING_IT_CREDENTIALS_FILE");
  const t = (JSON.parse(fs.readFileSync(file, "utf8")) as { supabaseAccessToken?: string }).supabaseAccessToken;
  if (!t) throw new Error("REFUSED: the credentials file has no supabaseAccessToken");
  return t;
}
const TOKEN = managementToken();
secrets.push(TOKEN);

async function mgmt(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(`${MGMT}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, json };
}

// The ref must be a non-default branch of production, otherwise nothing runs.
{
  const b = await mgmt(`/projects/${PROD_REF}/branches`);
  const mine = Array.isArray(b.json) ? b.json.find((x: any) => x.project_ref === REF) : null;
  if (!mine || mine.is_default) throw new Error(`REFUSED: ${REF} is not a non-default branch of the production project (status ${b.status})`);
}

/** Runs SQL on the BRANCH through the Management API. Evidence reads and setup only. */
async function sql<T = any>(query: string): Promise<T[]> {
  const r = await mgmt(`/projects/${REF}/database/query`, { method: "POST", body: { query } });
  if (r.status >= 300) throw new Error(`branch SQL failed (${r.status}): ${JSON.stringify(r.json).slice(0, 600)}`);
  return r.json as T[];
}

const keys = await mgmt(`/projects/${REF}/api-keys?reveal=true`);
const keyList: any[] = Array.isArray(keys.json) ? keys.json : [];
const SERVICE_KEY = keyList.find((k) => k.name === "service_role")?.api_key as string | undefined;
const ANON_KEY = keyList.find((k) => k.name === "anon")?.api_key as string | undefined;
if (!SERVICE_KEY || !ANON_KEY) throw new Error(`could not read the branch keys (status ${keys.status})`);
secrets.push(SERVICE_KEY, ANON_KEY);

if (process.env.BILLING_IT_APPLY_MIGRATIONS === "yes") {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const have = await sql<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='wallet_packs'");
  const files = have[0].n === 0 ? ["0139_wallet_ledger.sql", "0140_wallet_credit_lots.sql", "0141_wallet_tiers.sql", "0142_scheduled_posts_wallet_hold_reason.sql"] : ["0141_wallet_tiers.sql", "0142_scheduled_posts_wallet_hold_reason.sql"];
  for (const f of files) {
    await sql(fs.readFileSync(new URL(f, dir), "utf8").replaceAll("\r", ""));
    out(`applied ${f} to the branch`);
  }
}

// Wipe every variable that could point the backend at a real service, then set the branch and the fakes.
for (const k of Object.keys(process.env)) {
  if (/^(SUPABASE_|PADDLE_|SLACK_|RESEND_|CONTENT_SOURCES_|POSTHOG|ANTHROPIC_|WALLET_)/.test(k)) delete process.env[k];
}
const WEBHOOK_SECRET = "pdl_ntfset_fake_secret_for_tests";
const FAKE_PRICES = { starterPack: "pri_it_starter", growthPack: "pri_it_growth_pack", proTopUp: "pri_it_pro_topup", growthPlan: "pri_it_growth_plan", proPlan: "pri_it_pro_plan" };
Object.assign(process.env, {
  SUPABASE_URL: `https://${REF}.supabase.co`,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SUPABASE_ANON_KEY: ANON_KEY,
  WALLET_ENABLED: "true",
  WALLET_MODE: "on",
  PADDLE_PRICE_ID_LC_STARTER_PACK: FAKE_PRICES.starterPack,
  PADDLE_PRICE_ID_LC_GROWTH_PACK: FAKE_PRICES.growthPack,
  PADDLE_PRICE_ID_LC_PRO_TOPUP: FAKE_PRICES.proTopUp,
  PADDLE_PRICE_ID_GROWTH_PLAN: FAKE_PRICES.growthPlan,
  PADDLE_PRICE_ID_PRO_PLAN: FAKE_PRICES.proPlan,
});

// Test signing keys for the server to server engine token (generated here, never stored).
const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privJwk = { ...kp.privateKey.export({ format: "jwk" }), kid: "it-key", alg: "ES256", use: "sig" };
const pubJwk = { ...kp.publicKey.export({ format: "jwk" }), kid: "it-key", alg: "ES256", use: "sig" };
process.env.CONTENT_SOURCES_SIGNING_KEY_JWK = JSON.stringify(privJwk);
process.env.CONTENT_SOURCES_PUBLIC_JWK = JSON.stringify(pubJwk);
secrets.push((privJwk as any).d);

// Quiet the backend's own logging but keep it for evidence; the script prints through process.stdout only.
const logs: string[] = [];
for (const m of ["log", "info", "warn", "error"] as const) console[m] = (...a: unknown[]) => void logs.push(scrub(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")));

// ---------------------------------------------------------------------------------------------------------------------------------
// Real backend modules (dynamic imports, after the environment is set).
// ---------------------------------------------------------------------------------------------------------------------------------
const { supabase } = await import("../src/supabase.js");
const { createClient } = await import("@supabase/supabase-js");
const express = (await import("express")).default;
const { Environment } = await import("@paddle/paddle-node-sdk");
const { PaddleMorAdapter } = await import("../src/billing/paddle.js");
const { buildWebhookHandler } = await import("../src/http/webhook.js");
const { buildWalletRouter } = await import("../src/http/routes/wallet.routes.js");
const { createWalletLedger } = await import("../src/wallet/ledger.js");
const { getWalletService } = await import("../src/wallet/service.js");
const { runSchedulerCycle } = await import("../src/scheduler.js");
const { envelope, sign, transactionData, subscriptionData, adjustmentData } = await import("../src/billing/walletFixtures.testHelper.js");

const ledger = createWalletLedger(supabase as never);
const service = getWalletService();
const M = 1_000_000;
const credits = (micro: number) => micro / M;

// ---------------------------------------------------------------------------------------------------------------------------------
// Fakes: the competitor engine, the platform adapter.
// ---------------------------------------------------------------------------------------------------------------------------------
const engine = { mode: "ok" as "ok" | "fail", calls: [] as Array<{ path: string; claims: any; sigOk: boolean }> };
const engineServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const tokenStr = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const [h, p, sg] = tokenStr.split(".");
    let claims: any = null;
    let sigOk = false;
    try {
      claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
      sigOk = cryptoVerify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: pubJwk as never, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sg, "base64url"));
    } catch { /* recorded as not ok */ }
    engine.calls.push({ path: req.url ?? "", claims, sigOk });
    if (!sigOk) { res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ code: "bad_token", message: "token rejected" })); return; }
    if (engine.mode === "fail" && req.url === "/v1/blueprint") { res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ code: "boom", message: "fake engine failure" })); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ fake: true, path: req.url, echo: JSON.parse(body || "{}").input }));
  });
});
await new Promise<void>((r) => engineServer.listen(0, "127.0.0.1", r));
process.env.CONTENT_SOURCES_API_URL = `http://127.0.0.1:${(engineServer.address() as AddressInfo).port}`;

/** Fake platform adapter. The post's content is its tag: it picks the behaviour and is the platform post id. */
const adapter = {
  platform: "mastodon",
  posted: [] as string[],
  verified: [] as string[],
  async post(req: { content: string }) {
    adapter.posted.push(req.content);
    if (req.content.startsWith("FAILPOST")) return { success: false, platformPostId: null, errorMessage: "fake platform refused the post" };
    return { success: true, platformPostId: `pid:${req.content}`, errorMessage: null };
  },
  async verifyPublished(platformPostId: string) {
    adapter.verified.push(platformPostId);
    if (platformPostId.startsWith("pid:NOTLIVE")) return { verifiedLive: false, platformPostUrl: null, errorMessage: "fake read-back says not live" };
    return { verifiedLive: true, platformPostUrl: `https://fake.test/${platformPostId}`, errorMessage: null };
  },
};
const registry = { get: (p: string) => (p === "mastodon" ? adapter : undefined) } as never;

// ---------------------------------------------------------------------------------------------------------------------------------
// The webhook endpoint and the wallet routes, exactly as http/app.ts mounts them (webhook raw body, wallet json).
// ---------------------------------------------------------------------------------------------------------------------------------
const morAdapter = new PaddleMorAdapter("pdl_sdbx_apikey_fake_not_used", WEBHOOK_SECRET, Environment.sandbox, process.env);
const app = express();
app.post("/api/webhooks/mor", express.raw({ type: "application/json" }), buildWebhookHandler(morAdapter));
app.use("/api/wallet", express.json(), buildWalletRouter());
const appServer = http.createServer(app);
await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

let lastOcc = Date.now();
const nextOcc = () => new Date((lastOcc = Math.max(lastOcc + 1, Date.now()))).toISOString();
const uniq = () => randomBytes(5).toString("hex");

async function hook(eventType: string, data: unknown): Promise<{ status: number; body: string; err?: string[] }> {
  const logStart = logs.length;
  const body = envelope(eventType, data, `evt_${uniq()}`, nextOcc());
  const r = await fetch(`${BASE}/api/webhooks/mor`, { method: "POST", headers: { "content-type": "application/json", "paddle-signature": sign(body, WEBHOOK_SECRET) }, body });
  const text = await r.text();
  return { status: r.status, body: text, ...(r.status >= 400 ? { err: logs.slice(logStart).filter((l) => /fail|error|Cannot|violat/i.test(l)).map((l) => l.slice(0, 400)) } : {}) };
}
const periodOf = () => ({ starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString() });
const buyPack = (acc: string, priceId: string, txn = `txn_${uniq()}`) => hook("transaction.completed", transactionData({ id: txn, priceId, customData: { account_id: acc } }));
async function activatePlan(acc: string, priceId: string, subId = `sub_${uniq()}`) {
  const period = periodOf();
  const a = await hook("subscription.activated", subscriptionData({ id: subId, status: "active", priceId, customData: { account_id: acc }, periodEnd: period.ends_at }));
  const txn = `txn_${uniq()}`;
  const b = await hook("transaction.completed", transactionData({ id: txn, priceId, customData: { account_id: acc }, subscriptionId: subId, billingPeriod: period }));
  return { subId, txn, period, sub: a.status, pay: b.status, subErr: a.err, payErr: b.err };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Test accounts (created in the branch only) and evidence readers.
// ---------------------------------------------------------------------------------------------------------------------------------
interface Acct { id: string; email: string; password: string }
async function makeAccount(o: { confirmed?: boolean; legacy?: boolean } = {}): Promise<Acct> {
  const email = `it-${uniq()}@billing-it.example.test`;
  const password = `Pw-${uniq()}-${uniq()}`;
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: o.confirmed !== false });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  const id = data.user.id;
  await supabase.from("accounts").update({ email_failure_alerts_enabled: false }).eq("id", id);
  if (o.legacy) await sql(`insert into public.wallet_legacy_accounts (account_id, cutoff) values ('${id}', now())`);
  return { id, email, password };
}
async function makeSocial(accountId: string): Promise<string> {
  const v = await sql<{ id: string }>(`select vault.create_secret('fake-token-${uniq()}', 'it-${uniq()}') as id`);
  const { data, error } = await supabase.from("social_accounts").insert({ account_id: accountId, platform: "mastodon", platform_account_id: `pa-${uniq()}`, display_name: "IT", access_token_vault_id: v[0].id }).select("id").single();
  if (error || !data) throw new Error(`social account insert failed: ${error?.message}`);
  return data.id as string;
}
let mine: string[] = [];
/** One scheduler cycle that can only see this scenario's posts: every other pending post (left by an earlier scenario or run) is parked as a draft first. */
async function cycle(): Promise<void> {
  const keep = mine.length ? mine.map((x) => `'${x}'`).join(",") : "''";
  await sql(`update public.scheduled_posts set status='draft' where status in ('pending','posting') and id not in (${keep})`);
  await runSchedulerCycle(registry);
}
async function makePost(accountId: string, socialId: string, tag: string): Promise<string> {
  const { data, error } = await supabase.from("scheduled_posts").insert({ account_id: accountId, social_account_id: socialId, content: tag, status: "pending", scheduled_for: new Date(Date.now() - 60_000).toISOString() }).select("id").single();
  if (error || !data) throw new Error(`post insert failed: ${error?.message}`);
  mine.push(data.id as string);
  return data.id as string;
}
const postRow = async (id: string) => (await sql<any>(`select status, retry_count, wallet_hold_reason from public.scheduled_posts where id='${id}'`))[0];
async function wstate(acc: string) {
  const [r] = await sql<any>(`select
    (select balance_micro from public.wallet_accounts where account_id='${acc}') as balance_micro,
    (select coalesce(sum(remaining_units),0) from public.wallet_lots where account_id='${acc}')::bigint as remaining,
    (select coalesce(sum(reserved_units),0) from public.wallet_lots where account_id='${acc}')::bigint as reserved,
    (select count(*) from public.wallet_lots where account_id='${acc}')::int as lots,
    (select count(*) from public.wallet_holds where account_id='${acc}')::int as holds,
    (select count(*) from public.wallet_holds where account_id='${acc}' and status='held')::int as holds_held,
    (select count(*) from public.wallet_holds where account_id='${acc}' and status='committed')::int as holds_committed,
    (select count(*) from public.wallet_holds where account_id='${acc}' and status='released')::int as holds_released,
    (select count(*) from public.wallet_ledger where account_id='${acc}')::int as ledger_rows,
    (select count(*) from public.wallet_ledger where account_id='${acc}' and kind='hold_commit')::int as commits`);
  return { ...r, balance_micro: Number(r.balance_micro ?? 0), remaining: Number(r.remaining), reserved: Number(r.reserved) };
}
const lotsOf = (acc: string) => sql<any>(`select kind, granted_units::bigint as granted, remaining_units::bigint as remaining, reserved_units::bigint as reserved, expires_at, expired_at, bound_plan, source_key from public.wallet_lots where account_id='${acc}' order by granted_at, id`);
const ledgerOf = (acc: string) => sql<any>(`select kind, action_type, delta_micro::bigint as delta, balance_after_micro::bigint as bal from public.wallet_ledger where account_id='${acc}' order by created_at, id`);
const dbNow = async () => new Date((await sql<{ t: string }>("select now() as t"))[0].t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logHas = (re: RegExp) => logs.some((l) => re.test(l));
const sumDelta = (rows: any[], kind: string) => rows.filter((r) => r.kind === kind).reduce((a, r) => a + Number(r.delta), 0);

// ---------------------------------------------------------------------------------------------------------------------------------
// Scenario plumbing.
// ---------------------------------------------------------------------------------------------------------------------------------
interface Result { id: string; name: string; pass: boolean; evidence: string[] }
const results: Result[] = [];
async function scenario(id: string, name: string, fn: (c: (desc: string, cond: boolean, detail?: unknown) => void, ev: (s: string) => void) => Promise<void>): Promise<void> {
  const evidence: string[] = [];
  mine = [];
  let pass = true;
  const c = (desc: string, cond: boolean, detail?: unknown) => {
    if (!cond) pass = false;
    evidence.push(`${cond ? "ok  " : "FAIL"} ${desc}${detail === undefined ? "" : ` -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  };
  try {
    await fn(c, (s) => evidence.push(`     ${s}`));
  } catch (e) {
    pass = false;
    evidence.push(`FAIL exception (raw): ${e instanceof Error ? e.stack ?? e.message : JSON.stringify(e)}`);
  }
  results.push({ id, name, pass, evidence });
  out(`${pass ? "PASS" : "FAIL"}  (${id}) ${name}`);
  for (const l of evidence) out(`        ${l}`);
}

async function jwtFor(a: Acct): Promise<string> {
  const anon = createClient(process.env.SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
  // The branch has captcha on password sign-in, so a session is made from an admin generated magic link token instead.
  const link = await supabase.auth.admin.generateLink({ type: "magiclink", email: a.email });
  const hashed = link.data?.properties?.hashed_token;
  if (link.error || !hashed) throw new Error(`generateLink failed: ${link.error?.message}`);
  const { data, error } = await anon.auth.verifyOtp({ token_hash: hashed, type: "magiclink" });
  if (error || !data.session) throw new Error(`session from link failed: ${error?.message}`);
  secrets.push(data.session.access_token);
  return data.session.access_token;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Baseline: the schema the scenarios depend on.
// ---------------------------------------------------------------------------------------------------------------------------------
out(`target: throwaway branch ${REF} (non-default branch of the production project, confirmed through the Management API)`);
{
  const [b] = await sql<any>(`select (select count(*) from public.wallet_packs)::int packs, (select string_agg(action_type||'='||price_micro||'/'||active, ',' order by action_type) from public.wallet_prices) prices,
    (select count(*) from information_schema.columns where table_name='accounts' and column_name='payg_unlocked_at')::int c0141,
    (select count(*) from information_schema.columns where table_name='scheduled_posts' and column_name='wallet_hold_reason')::int c0142,
    (select count(*) from public.accounts)::int accounts`);
  out(`baseline: packs=${b.packs} prices=[${b.prices}] 0141 column=${b.c0141} 0142 column=${b.c0142} accounts before test=${b.accounts}`);
  if (b.packs !== 5 || b.c0141 !== 1 || b.c0142 !== 1) throw new Error("the branch does not have migrations 0139 to 0142 applied (set BILLING_IT_APPLY_MIGRATIONS=yes once)");
}

// (a) ------------------------------------------------------------------------------------------------------------------------------
await scenario("a", "signup grant: confirmed gets 30, unconfirmed and legacy get none, replay grants once", async (c, ev) => {
  const ok = await makeAccount();
  const unconf = await makeAccount({ confirmed: false });
  const legacy = await makeAccount({ legacy: true });
  const r1 = await service.ensureSignupGrant(ok.id);
  const r2 = await service.ensureSignupGrant(ok.id);
  const r3 = await service.ensureSignupGrant(unconf.id);
  const r4 = await service.ensureSignupGrant(legacy.id);
  const sOk = await wstate(ok.id);
  c("confirmed account granted", r1.granted === true, r1);
  c("replay is not granted again", r2.granted === false && r2.reason === "replay", r2);
  c("exactly one signup lot of 30 credits", sOk.lots === 1 && sOk.remaining === 30 * M && sOk.balance_micro === 30 * M, { lots: sOk.lots, remaining_micro: sOk.remaining, balance_micro: sOk.balance_micro });
  const sU = await wstate(unconf.id);
  c("unconfirmed e-mail gets nothing", r3.granted === false && r3.reason === "email_unconfirmed" && sU.lots === 0, { r3, lots: sU.lots });
  const sL = await wstate(legacy.id);
  c("legacy account gets nothing", r4.granted === false && r4.reason === "legacy" && sL.lots === 0, { r4, lots: sL.lots });
  ev(`ledger rows for the confirmed account: ${JSON.stringify(await ledgerOf(ok.id))}`);
});

// (b) ------------------------------------------------------------------------------------------------------------------------------
await scenario("b", "Paddle Starter pack webhook grants a never-expiring 300 credit lot; replay grants nothing more", async (c, ev) => {
  const a = await makeAccount();
  const txn = `txn_${uniq()}`;
  const w1 = await buyPack(a.id, FAKE_PRICES.starterPack, txn);
  const lots1 = await lotsOf(a.id);
  const s1 = await wstate(a.id);
  const w2 = await buyPack(a.id, FAKE_PRICES.starterPack, txn);
  const s2 = await wstate(a.id);
  c("first webhook accepted (200)", w1.status === 200, w1);
  c("one pack lot, 300 credits, no expiry", lots1.length === 1 && lots1[0].kind === "pack" && Number(lots1[0].granted) === 300 * M && lots1[0].expires_at === null, lots1);
  c("balance is 300 credits", s1.balance_micro === 300 * M, s1.balance_micro);
  c("replay accepted (200) and grants nothing", w2.status === 200 && s2.lots === 1 && s2.balance_micro === 300 * M, { status: w2.status, lots: s2.lots, balance_micro: s2.balance_micro });
  const sale = await sql<any>(`select count(*)::int n from public.billing_records where paddle_transaction_id='${txn}'`);
  ev(`billing_records rows for the transaction: ${sale[0].n}`);
});

// (c) ------------------------------------------------------------------------------------------------------------------------------
const proAccount = await makeAccount();
await scenario("c", "plan activation: Pro grants 6,000 monthly credits expiring at period end and sets lazy_pro; Growth grants 1,000", async (c, ev) => {
  const pro = await activatePlan(proAccount.id, FAKE_PRICES.proPlan);
  const lots = await lotsOf(proAccount.id);
  const [sub] = await sql<any>(`select tier, status, mor_subscription_id from public.subscriptions where account_id='${proAccount.id}'`);
  c("both webhooks accepted", pro.sub === 200 && pro.pay === 200, { sub: pro.sub, pay: pro.pay, subErr: pro.subErr, payErr: pro.payErr });
  c("tier lazy_pro, active", sub?.tier === "lazy_pro" && sub?.status === "active", sub);
  const lot = lots.find((l: any) => l.kind === "subscription");
  c("one subscription lot of 6,000 credits bound to pro", !!lot && Number(lot.granted) === 6000 * M && lot.bound_plan === "pro", lot);
  c("lot expires at the billing period end", !!lot && Math.abs(new Date(lot.expires_at).getTime() - new Date(pro.period.ends_at).getTime()) < 2000, { expires_at: lot?.expires_at, period_end: pro.period.ends_at });
  const replay = await hook("transaction.completed", transactionData({ id: pro.txn, priceId: FAKE_PRICES.proPlan, customData: { account_id: proAccount.id }, subscriptionId: pro.subId, billingPeriod: pro.period }));
  c("replay of the payment grants nothing more", replay.status === 200 && (await lotsOf(proAccount.id)).length === 1);

  const g = await makeAccount();
  const gp = await activatePlan(g.id, FAKE_PRICES.growthPlan);
  const gl = (await lotsOf(g.id)).find((l: any) => l.kind === "subscription");
  const [gs] = await sql<any>(`select tier, status from public.subscriptions where account_id='${g.id}'`);
  c("Growth: 1,000 credits, tier growth", gp.sub === 200 && gp.pay === 200 && !!gl && Number(gl.granted) === 1000 * M && gs?.tier === "growth", { granted: gl?.granted, tier: gs?.tier });
  ev(`pro lot ${JSON.stringify(lot)}`);
});

// (d) ------------------------------------------------------------------------------------------------------------------------------
await scenario("d", "Pro-only top-up refused for a non-Pro account (no grant, alert raised) and accepted for Pro", async (c, ev) => {
  const free = await makeAccount();
  const before = logs.length;
  const txn = `txn_${uniq()}`;
  const w = await buyPack(free.id, FAKE_PRICES.proTopUp, txn);
  const s = await wstate(free.id);
  const alert = logs.slice(before).some((l) => /\[ops-alert\].*Refused lazycredits-pro-top-up/.test(l));
  c("webhook answered 200 (a retry could not fix it)", w.status === 200, w);
  c("no lot and no balance for the non-Pro account", s.lots === 0 && s.balance_micro === 0, { lots: s.lots, balance_micro: s.balance_micro });
  c("ops alert raised naming the refused SKU", alert, logs.slice(before).filter((l) => /ops-alert/.test(l)).map((l) => l.slice(0, 160)));
  const pBefore = (await wstate(proAccount.id)).balance_micro;
  const w2 = await buyPack(proAccount.id, FAKE_PRICES.proTopUp);
  const lots = await lotsOf(proAccount.id);
  const top = lots.find((l: any) => l.kind === "pack");
  const pAfter = (await wstate(proAccount.id)).balance_micro;
  c("Pro account accepted: 1,500 credit pack lot bound to pro", w2.status === 200 && !!top && Number(top.granted) === 1500 * M && top.bound_plan === "pro", top);
  c("Pro balance rose by exactly 1,500 credits", pAfter - pBefore === 1500 * M, { before: pBefore, after: pAfter });
  ev(`non-Pro refusal text: ${logs.slice(before).find((l) => /Refused/.test(l))?.slice(0, 220)}`);
});

// (e) ------------------------------------------------------------------------------------------------------------------------------
async function setupPoster(opts: { credits?: number; legacy?: boolean } = {}) {
  const a = await makeAccount({ legacy: opts.legacy });
  const sa = await makeSocial(a.id);
  if (opts.credits) {
    if (opts.credits === 30) await service.ensureSignupGrant(a.id);
    else await ledger.grant({ accountId: a.id, kind: "pack", credits: opts.credits, sourceKey: `it-seed-${uniq()}` });
  }
  return { a, sa };
}
await scenario("e1", "scheduler success: hold, post, verifyPublished live, commit (balance down by 1 credit)", async (c, ev) => {
  const { a, sa } = await setupPoster({ credits: 30 });
  const tag = `OK-${uniq()}`;
  const pid = await makePost(a.id, sa, tag);
  await cycle();
  const p = await postRow(pid);
  const s = await wstate(a.id);
  const led = await ledgerOf(a.id);
  c("post is posted", p.status === "posted", p);
  c("adapter sent it once and read it back", adapter.posted.filter((x) => x.startsWith(tag)).length === 1 && adapter.verified.some((x) => x.startsWith(`pid:${tag}`)));
  c("one hold, committed; none left held", s.holds === 1 && s.holds_committed === 1 && s.holds_held === 0, { holds: s.holds, committed: s.holds_committed, held: s.holds_held });
  c("balance 29 credits (down by exactly 1)", s.balance_micro === 29 * M && s.remaining === 29 * M && s.reserved === 0, { balance_micro: s.balance_micro, remaining: s.remaining, reserved: s.reserved });
  c("ledger has a hold_commit of -1 credit", sumDelta(led, "hold_commit") === -M, led);
});
await scenario("e2", "scheduler failure and unconfirmed read-back release the hold (balance unchanged)", async (c) => {
  const { a, sa } = await setupPoster({ credits: 30 });
  const tag = `FAILPOST-${uniq()}`;
  const pid = await makePost(a.id, sa, tag);
  await cycle();
  const p = await postRow(pid);
  const s = await wstate(a.id);
  c("platform refused: post not posted", p.status !== "posted", p);
  c("hold released, nothing committed, balance unchanged at 30", s.holds === 1 && s.holds_released === 1 && s.holds_committed === 0 && s.balance_micro === 30 * M && s.reserved === 0, { holds: s.holds, released: s.holds_released, committed: s.holds_committed, balance_micro: s.balance_micro, reserved: s.reserved });

  const b = await setupPoster({ credits: 30 });
  const tag2 = `NOTLIVE-${uniq()}`;
  const pid2 = await makePost(b.a.id, b.sa, tag2);
  await cycle();
  const p2 = await postRow(pid2);
  const s2 = await wstate(b.a.id);
  c("read-back not live: not posted", p2.status !== "posted", p2);
  c("hold released, balance unchanged at 30", s2.holds_committed === 0 && s2.holds_released === 1 && s2.balance_micro === 30 * M && s2.reserved === 0, { committed: s2.holds_committed, released: s2.holds_released, balance_micro: s2.balance_micro, reserved: s2.reserved });
});
await scenario("e3", "empty wallet leaves the post pending with a reason; after a top-up the same post publishes", async (c, ev) => {
  // (i) an account that never had a wallet row
  const { a, sa } = await setupPoster();
  const tag = `OK-${uniq()}`;
  const pid = await makePost(a.id, sa, tag);
  await cycle();
  const p = await postRow(pid);
  c("(i) no wallet row: pending, reason set, not sent", p.status === "pending" && !!p.wallet_hold_reason && !adapter.posted.some((x) => x.startsWith(tag)), p);
  await buyPack(a.id, FAKE_PRICES.starterPack);
  await cycle();
  const p2 = await postRow(pid);
  const s = await wstate(a.id);
  c("(i) after a Starter pack top-up the SAME post is posted, reason cleared", p2.status === "posted" && p2.wallet_hold_reason === null && adapter.posted.some((x) => x.startsWith(tag)), p2);
  c("(i) 299 credits left", s.balance_micro === 299 * M, s.balance_micro);

  // (ii) a drained wallet (a wallet row exists with 0 credits)
  const d = await setupPoster({ credits: 1 });
  const first = await makePost(d.a.id, d.sa, `OK-${uniq()}`);
  await cycle();
  const second = `OK-${uniq()}`;
  const pid2 = await makePost(d.a.id, d.sa, second);
  await cycle();
  const q = await postRow(pid2);
  const sd = await wstate(d.a.id);
  c("(ii) drained wallet: first post used the last credit", (await postRow(first)).status === "posted" && sd.balance_micro === 0, sd.balance_micro);
  c("(ii) drained wallet: second post stays pending and was not sent", q.status === "pending" && !adapter.posted.some((x) => x.startsWith(second)), q);
  c("(ii) drained wallet: wallet_hold_reason is set so the customer can see why", !!q.wallet_hold_reason, q.wallet_hold_reason);
  await buyPack(d.a.id, FAKE_PRICES.starterPack);
  await cycle();
  c("(ii) after the top-up the same post publishes", (await postRow(pid2)).status === "posted", await postRow(pid2));
});
await scenario("e4", "legacy account is never charged (no hold, no ledger row, no balance)", async (c) => {
  const { a, sa } = await setupPoster({ legacy: true });
  const pid = await makePost(a.id, sa, `OK-${uniq()}`);
  await cycle();
  const s = await wstate(a.id);
  c("post is posted", (await postRow(pid)).status === "posted");
  c("no holds, no ledger rows, no wallet balance", s.holds === 0 && s.ledger_rows === 0 && s.balance_micro === 0, { holds: s.holds, ledger_rows: s.ledger_rows, balance_micro: s.balance_micro });
});
await scenario("e5", "shadow mode never blocks (empty wallet still publishes, nothing charged)", async (c) => {
  const { a, sa } = await setupPoster();
  process.env.WALLET_MODE = "shadow";
  try {
    const before = logs.length;
    const pid = await makePost(a.id, sa, `OK-${uniq()}`);
    await cycle();
    const s = await wstate(a.id);
    c("post is posted", (await postRow(pid)).status === "posted");
    c("no holds and no ledger rows", s.holds === 0 && s.ledger_rows === 0, { holds: s.holds, ledger_rows: s.ledger_rows });
    c("the would-charge line was logged", logs.slice(before).some((l) => /wallet-shadow\] would charge 1 credit/.test(l)));
  } finally {
    process.env.WALLET_MODE = "on";
  }
});

// (f) ------------------------------------------------------------------------------------------------------------------------------
await scenario("f", "teardown route: commit on success, release on engine failure, replay charges once, srv token <= 120 s", async (c, ev) => {
  const a = await makeAccount();
  await service.ensureSignupGrant(a.id);
  const jwt = await jwtFor(a);
  const call = async (key: string) => {
    const r = await fetch(`${BASE}/api/wallet/teardown`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ input: "https://competitor.example.test" }) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  const k1 = `it-${uniq()}`;
  engine.calls.length = 0;
  const r1 = await call(k1);
  const s1 = await wstate(a.id);
  const calls1 = engine.calls.slice();
  c("success: 200, charged true", r1.status === 200 && r1.body.charged === true, { status: r1.status, charged: r1.body.charged });
  c("balance 20 credits, one hold committed, ledger -10", s1.balance_micro === 20 * M && s1.holds_committed === 1 && sumDelta(await ledgerOf(a.id), "hold_commit") === -10 * M, { balance_micro: s1.balance_micro, committed: s1.holds_committed });
  c("engine called twice (analyze, blueprint) with a verified server token", calls1.length === 2 && calls1.every((x) => x.sigOk && x.claims?.srv === true), calls1.map((x) => ({ path: x.path, srv: x.claims?.srv, sigOk: x.sigOk })));
  c("token lifetime is at most 120 seconds", calls1.every((x) => x.claims.exp - x.claims.iat <= 120 && x.claims.exp - x.claims.iat > 0), calls1.map((x) => x.claims.exp - x.claims.iat));
  c("token names the signed in account", calls1.every((x) => x.claims.acc === a.id && x.claims.sub === a.id));

  engine.calls.length = 0;
  const r1b = await call(k1);
  const s1b = await wstate(a.id);
  c("replay of the same Idempotency-Key: 409, engine not called, charged once", r1b.status === 409 && engine.calls.length === 0 && s1b.balance_micro === 20 * M && s1b.holds_committed === 1 && s1b.holds === 1, { status: r1b.status, error: r1b.body.error, engine_calls: engine.calls.length, balance_micro: s1b.balance_micro, holds: s1b.holds });

  engine.mode = "fail";
  const k2 = `it-${uniq()}`;
  const r2 = await call(k2);
  engine.mode = "ok";
  const s2 = await wstate(a.id);
  c("engine failure: 502, charged false", r2.status === 502 && r2.body.charged === false, { status: r2.status, body: r2.body });
  c("hold released, balance unchanged at 20, nothing reserved", s2.balance_micro === 20 * M && s2.holds_released === 1 && s2.reserved === 0 && s2.holds_committed === 1, { balance_micro: s2.balance_micro, released: s2.holds_released, reserved: s2.reserved });

  const poor = await makeAccount();
  const jwt2 = await jwtFor(poor);
  const r3 = await fetch(`${BASE}/api/wallet/teardown`, { method: "POST", headers: { authorization: `Bearer ${jwt2}`, "content-type": "application/json", "idempotency-key": `it-${uniq()}` }, body: JSON.stringify({ input: "https://x.example.test" }) });
  const b3: any = await r3.json();
  c("account with no credits: 402 insufficient_credits, engine not called", r3.status === 402 && b3.error === "insufficient_credits", { status: r3.status, body: b3 });
  const bal = await fetch(`${BASE}/api/wallet/balance`, { headers: { authorization: `Bearer ${jwt}` } });
  const bj: any = await bal.json();
  c("GET /wallet/balance shows 20 credits", bal.status === 200 && bj.spendableMicro === 20 * M, { status: bal.status, display: bj.displayCredits, spendableMicro: bj.spendableMicro });
});

// (g) ------------------------------------------------------------------------------------------------------------------------------
await scenario("g", "plan lifecycle: past_due keeps credits, scheduled cancel keeps credits, canceled lapses, full refund and chargeback revoke", async (c, ev) => {
  const a = await makeAccount();
  const act = await activatePlan(a.id, FAKE_PRICES.proPlan);
  const alive = async () => { const l = (await lotsOf(a.id)).find((x: any) => x.kind === "subscription"); return { remaining: Number(l.remaining), expired_at: l.expired_at, expires_at: l.expires_at }; };
  const base = await alive();
  c("start: 6,000 credits live", base.remaining === 6000 * M && base.expired_at === null, base);

  const pd = await hook("subscription.past_due", subscriptionData({ id: act.subId, status: "past_due", priceId: FAKE_PRICES.proPlan, customData: { account_id: a.id }, periodEnd: act.period.ends_at }));
  const afterPd = await alive();
  const ledPd = await ledgerOf(a.id);
  c("past_due: 200, lot untouched, no expire entry", pd.status === 200 && afterPd.remaining === 6000 * M && afterPd.expired_at === null && sumDelta(ledPd, "expire") === 0, { status: pd.status, afterPd, expireDelta: sumDelta(ledPd, "expire") });

  await hook("subscription.updated", subscriptionData({ id: act.subId, status: "active", priceId: FAKE_PRICES.proPlan, customData: { account_id: a.id }, periodEnd: act.period.ends_at }));
  const sched = await hook("subscription.updated", subscriptionData({ id: act.subId, status: "active", priceId: FAKE_PRICES.proPlan, customData: { account_id: a.id }, periodEnd: act.period.ends_at, scheduledChange: { action: "cancel", effective_at: act.period.ends_at, resume_at: null } }));
  const afterSched = await alive();
  const [subRow] = await sql<any>(`select tier, status, cancel_at_period_end from public.subscriptions where account_id='${a.id}'`);
  c("cancel scheduled (status still active): lot untouched, flag set", sched.status === 200 && afterSched.remaining === 6000 * M && afterSched.expired_at === null && subRow.cancel_at_period_end === true, { status: sched.status, afterSched, subRow });

  const cancel = await hook("subscription.canceled", subscriptionData({ id: act.subId, status: "canceled", priceId: FAKE_PRICES.proPlan, customData: { account_id: a.id }, periodEnd: act.period.ends_at }));
  const afterCancel = await alive();
  const ledC = await ledgerOf(a.id);
  const st = await wstate(a.id);
  c("period-end cancellation: lot lapsed, 6,000 credits expired, spendable 0", cancel.status === 200 && afterCancel.remaining === 0 && afterCancel.expired_at !== null && sumDelta(ledC, "expire") === -6000 * M && st.balance_micro === 0, { status: cancel.status, afterCancel, expireDelta: sumDelta(ledC, "expire"), balance_micro: st.balance_micro });
  const cancel2 = await hook("subscription.canceled", subscriptionData({ id: act.subId, status: "canceled", priceId: FAKE_PRICES.proPlan, customData: { account_id: a.id }, periodEnd: act.period.ends_at }));
  c("replay of the cancellation changes nothing", cancel2.status === 200 && sumDelta(await ledgerOf(a.id), "expire") === -6000 * M);

  for (const action of ["refund", "chargeback"] as const) {
    const r = await makeAccount();
    const p = await activatePlan(r.id, FAKE_PRICES.proPlan);
    const adj = await hook("adjustment.created", adjustmentData({ id: `adj_${uniq()}`, transactionId: p.txn, subscriptionId: p.subId, action, type: "full" }));
    const l = (await lotsOf(r.id)).find((x: any) => x.kind === "subscription");
    const s = await wstate(r.id);
    c(`full ${action}: 200, plan lot revoked (remaining 0, expired), spendable 0`, adj.status === 200 && Number(l.remaining) === 0 && l.expired_at !== null && s.balance_micro === 0, { status: adj.status, remaining: String(l.remaining), expired_at: l.expired_at, balance_micro: s.balance_micro });
  }
  const pr = await makeAccount();
  const pp = await activatePlan(pr.id, FAKE_PRICES.proPlan);
  const part = await hook("adjustment.created", adjustmentData({ id: `adj_${uniq()}`, transactionId: pp.txn, subscriptionId: pp.subId, action: "refund", type: "partial" }));
  c("partial refund does NOT revoke the plan credits", part.status === 200 && Number((await lotsOf(pr.id)).find((x: any) => x.kind === "subscription").remaining) === 6000 * M);
});

// (h) ------------------------------------------------------------------------------------------------------------------------------
await scenario("h", "spend order: expiring lots (earliest expiry first) before non-expiring lots (oldest first)", async (c, ev) => {
  const a = await makeAccount();
  const rpc = async (fn: string, args: Record<string, unknown>) => { const { data, error } = await supabase.rpc(fn as never, args as never); if (error) throw new Error(`${fn}: ${error.message}`); return data as any; };
  const t = await dbNow();
  const inDays = (d: number) => new Date(t.getTime() + d * 86_400_000).toISOString();
  await rpc("wallet_grant", { p_account_id: a.id, p_kind: "signup", p_units: 30 * M, p_expires_at: null, p_source_key: `h-signup-${uniq()}` });
  await rpc("wallet_grant", { p_account_id: a.id, p_kind: "pack", p_units: 10 * M, p_expires_at: null, p_source_key: `h-pack-${uniq()}` });
  await rpc("wallet_grant", { p_account_id: a.id, p_kind: "subscription", p_units: 5 * M, p_expires_at: inDays(20), p_source_key: `h-subB-${uniq()}` });
  await rpc("wallet_grant", { p_account_id: a.id, p_kind: "subscription", p_units: 5 * M, p_expires_at: inDays(5), p_source_key: `h-subA-${uniq()}` });
  const r = await ledger.charge({ accountId: a.id, action: "post_publish", units: 12, idempotencyKey: `h-${uniq()}` });
  const lots = await lotsOf(a.id);
  const by = (k: string, exp?: string) => lots.find((l: any) => l.kind === k && (exp === undefined || (exp === "soon" ? new Date(l.expires_at).getTime() < t.getTime() + 10 * 86_400_000 : new Date(l.expires_at).getTime() > t.getTime() + 10 * 86_400_000)));
  const rem = (l: any) => Number(l.remaining);
  c("charge of 12 credits succeeded", r.ok === true, r);
  c("subscription lot expiring in 5 days spent first (0 left)", rem(by("subscription", "soon")) === 0);
  c("subscription lot expiring in 20 days next (0 left)", rem(by("subscription", "late")) === 0);
  c("then the oldest non-expiring lot: signup 30 -> 28", rem(by("signup")) === 28 * M, rem(by("signup")));
  c("newer pack lot untouched at 10", rem(by("pack")) === 10 * M, rem(by("pack")));
  ev(`ledger breakdown row: ${JSON.stringify((await sql<any>(`select lot_breakdown from public.wallet_ledger where account_id='${a.id}' and kind='charge'`))[0]?.lot_breakdown)}`);
});

// (i) ------------------------------------------------------------------------------------------------------------------------------
await scenario("i", "expiry job expires a lapsed lot and a stale hold", async (c, ev) => {
  const a = await makeAccount();
  const rpc = async (fn: string, args: Record<string, unknown>) => { const { data, error } = await supabase.rpc(fn as never, args as never); if (error) throw new Error(`${fn}: ${error.message}`); return data as any; };
  const [t] = await sql<{ t: string }>("select (now() + interval '3 seconds') as t");
  await rpc("wallet_grant", { p_account_id: a.id, p_kind: "subscription", p_units: 5 * M, p_expires_at: t.t, p_source_key: `i-sub-${uniq()}` });
  await sleep(4500);
  const r = await ledger.expire(await dbNow());
  const lot = (await lotsOf(a.id))[0];
  const led = await ledgerOf(a.id);
  c("wallet_expire reports at least one expired lot", r.expiredLots >= 1, r);
  c("lot has 0 remaining and an expired_at", Number(lot.remaining) === 0 && lot.expired_at !== null, lot);
  c("ledger has an expire entry of -5 credits, balance back to 0", sumDelta(led, "expire") === -5 * M && (await wstate(a.id)).balance_micro === 0, led);

  const b = await makeAccount();
  await ledger.grant({ accountId: b.id, kind: "pack", credits: 5, sourceKey: `i-pack-${uniq()}` });
  const h = await ledger.hold({ accountId: b.id, action: "post_publish", idempotencyKey: `i-hold-${uniq()}` });
  if (!h.ok || "exempt" in h) throw new Error("hold was not created");
  const heldBefore = await wstate(b.id);
  await sql(`update public.wallet_holds set expires_at = now() - interval '1 minute' where account_id='${b.id}'`);
  const e = await ledger.expireHolds(await dbNow());
  const hs = await sql<any>(`select status from public.wallet_holds where account_id='${b.id}'`);
  const after = await wstate(b.id);
  c("hold was reserving 1 credit before", heldBefore.reserved === M, heldBefore.reserved);
  c("wallet_expire_holds expired it and freed the credit", e.expiredHolds >= 1 && hs[0].status === "expired" && after.reserved === 0 && after.balance_micro === 5 * M, { e, status: hs[0].status, reserved: after.reserved, balance_micro: after.balance_micro });
});

// (j) ------------------------------------------------------------------------------------------------------------------------------
await scenario("j", "concurrency: 20 parallel holds against a balance covering 10 -> exactly 10 succeed, never negative", async (c, ev) => {
  const a = await makeAccount();
  await ledger.grant({ accountId: a.id, kind: "pack", credits: 10, sourceKey: `j-${uniq()}` });
  const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => ledger.hold({ accountId: a.id, action: "post_publish", idempotencyKey: `j-${i}-${uniq()}` })));
  const okN = settled.filter((s) => s.status === "fulfilled" && s.value.ok === true).length;
  const shortN = settled.filter((s) => s.status === "fulfilled" && s.value.ok === false).length;
  const errN = settled.filter((s) => s.status === "rejected").length;
  const s = await wstate(a.id);
  c("exactly 10 holds succeeded, 10 refused, 0 errors", okN === 10 && shortN === 10 && errN === 0, { ok: okN, insufficient: shortN, errors: errN });
  c("10 holds in the table, 10 credits reserved, nothing negative", s.holds === 10 && s.holds_held === 10 && s.reserved === 10 * M && s.remaining === 10 * M && s.balance_micro === 10 * M, { holds: s.holds, reserved: s.reserved, remaining: s.remaining, balance_micro: s.balance_micro });
  const settled2 = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => ledger.charge({ accountId: a.id, action: "post_publish", idempotencyKey: `j2-${i}-${uniq()}` })));
  c("with all 10 credits reserved, 12 parallel direct charges all refused", settled2.every((x) => x.status === "fulfilled" && x.value.ok === false), settled2.map((x) => (x.status === "fulfilled" ? (x.value as any).ok : "err")).join(","));
  const b = await makeAccount();
  await ledger.grant({ accountId: b.id, kind: "pack", credits: 10, sourceKey: `j3-${uniq()}` });
  const settled3 = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => ledger.charge({ accountId: b.id, action: "post_publish", idempotencyKey: `j3-${i}-${uniq()}` })));
  const ok3 = settled3.filter((x) => x.status === "fulfilled" && x.value.ok === true).length;
  const sb = await wstate(b.id);
  c("20 parallel direct charges on 10 credits: exactly 10 succeed, balance 0", ok3 === 10 && sb.balance_micro === 0 && sb.remaining === 0, { ok: ok3, balance_micro: sb.balance_micro, remaining: sb.remaining });
});

// ---------------------------------------------------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
out("");
out(`SUMMARY: ${results.length - failed.length} of ${results.length} scenarios passed`);
for (const r of results) out(`  ${r.pass ? "PASS" : "FAIL"}  (${r.id}) ${r.name}`);
engineServer.close();
appServer.close();
process.exit(failed.length === 0 ? 0 : 1);
