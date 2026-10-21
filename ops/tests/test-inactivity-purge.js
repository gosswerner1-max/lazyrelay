// Unit tests for ops/accounts/inactivity_purge_ops.js. No network, no database: a small in-memory fake of the
// Supabase client stands in, so eligibility and every safety gate can be proven without touching any real project.
// Run: node ops/tests/test-inactivity-purge.js   (exit code 1 on any failure)
process.env.NODE_ENV = process.env.NODE_ENV || "test"; // lets internalTestAccounts.js load without the local family list

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const purge = require("../accounts/inactivity_purge_ops.js");
const { runInactivityPurgeSweep, computeCutoff, purgeAccount } = purge;

const NOW = new Date("2026-10-21T12:00:00.000Z");
const CUTOFF_ISO = "2026-04-21T12:00:00.000Z"; // now minus 6 calendar months
const OLD = "2025-12-01T00:00:00.000Z"; // well before the cutoff
const FIVE_M_29_D = "2026-04-22T12:00:00.000Z"; // 5 months 29 days before NOW: newer than the cutoff
const SIX_M_1_D = "2026-04-20T12:00:00.000Z"; // 6 months 1 day before NOW: older than the cutoff

// ---------------------------------------------------------------- in-memory fake of the Supabase client
function makeWorld() {
  return {
    tables: {
      accounts: [], subscriptions: [], wallet_legacy_accounts: [], scheduled_posts: [], post_results: [], api_keys: [],
      wallet_ledger: [], wallet_lots: [], social_accounts: [], google_calendar_connections: [], google_sheets_connections: [],
      whatsapp_chat_messages: [], whatsapp_conversations: [], media_uploads: [], billing_records: [], account_members: [], brands: [],
    },
    authUsers: {}, // id -> { last_sign_in_at }
    errors: {}, // "select:scheduled_posts" -> message
    calls: { rpc: [], removed: [], authDeleted: [], deletes: [] },
  };
}

function makeFake(world) {
  function fail(op, table) {
    const message = world.errors[`${op}:${table}`];
    return message ? { data: null, error: new Error(message) } : null;
  }
  function from(table) {
    const s = { op: "select", filters: [], order: null, limit: null, range: null, single: false, patch: null };
    const q = {
      select() { return q; },
      eq(c, v) { s.filters.push((r) => r[c] === v); return q; },
      lte(c, v) { s.filters.push((r) => r[c] != null && r[c] <= v); return q; },
      is(c, v) { s.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
      not(c, _op, v) { s.filters.push((r) => (v === null ? r[c] != null : r[c] !== v)); return q; },
      or(expr) {
        const parts = expr.split(",").map((p) => p.split("."));
        s.filters.push((r) => parts.some(([c, , v]) => r[c] === v));
        return q;
      },
      order(c, o) { s.order = { c, asc: !o || o.ascending !== false }; return q; },
      limit(n) { s.limit = n; return q; },
      range(a, b) { s.range = [a, b]; return q; },
      maybeSingle() { s.single = true; return q; },
      single() { s.single = true; return q; },
      delete() { s.op = "delete"; return q; },
      update(p) { s.op = "update"; s.patch = p; return q; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    function exec() {
      const err = fail(s.op, table);
      if (err) return err;
      const rows = world.tables[table];
      if (!rows) return { data: null, error: new Error(`relation "${table}" does not exist`) };
      let hit = rows.filter((r) => s.filters.every((f) => f(r)));
      if (s.op === "delete") {
        world.calls.deletes.push(table);
        world.tables[table] = rows.filter((r) => !hit.includes(r));
        if (table === "accounts") {
          // simulate ON DELETE CASCADE everywhere except the append-only ledger (it has no foreign key)
          for (const t of Object.keys(world.tables)) {
            if (t === "wallet_ledger" || t === "accounts") continue;
            world.tables[t] = world.tables[t].filter((r) => !hit.some((a) => r.account_id === a.id));
          }
        }
        return { data: null, error: null };
      }
      if (s.op === "update") { hit.forEach((r) => Object.assign(r, s.patch)); return { data: null, error: null }; }
      if (s.order) hit = [...hit].sort((a, b) => (a[s.order.c] < b[s.order.c] ? -1 : 1) * (s.order.asc ? 1 : -1));
      if (s.range) hit = hit.slice(s.range[0], s.range[1] + 1);
      if (s.limit != null) hit = hit.slice(0, s.limit);
      if (s.single) return { data: hit[0] ?? null, error: null };
      return { data: hit, error: null };
    }
    return q;
  }
  return {
    from,
    rpc: async (name, args) => {
      world.calls.rpc.push({ name, args });
      if (world.errors[`rpc:${name}`]) return { data: null, error: new Error(world.errors[`rpc:${name}`]) };
      return { data: null, error: null };
    },
    storage: { from: () => ({ remove: async (paths) => { world.calls.removed.push(...paths); return { error: null }; } }) },
    auth: {
      admin: {
        getUserById: async (id) => {
          if (world.errors["auth:getUserById"]) return { data: { user: null }, error: new Error(world.errors["auth:getUserById"]) };
          const u = world.authUsers[id];
          return u ? { data: { user: { id, ...u } }, error: null } : { data: { user: null }, error: new Error("User not found") };
        },
        deleteUser: async (id) => {
          if (world.errors["auth:deleteUser"]) return { error: new Error(world.errors["auth:deleteUser"]) };
          world.calls.authDeleted.push(id);
          delete world.authUsers[id];
          return { error: null };
        },
      },
    },
  };
}

let counter = 0;
/** An account that is eligible by default: old, no subscription, every signal before the cutoff. */
function addAccount(world, over = {}) {
  const id = over.id ?? `acc-${++counter}`;
  world.tables.accounts.push({
    id, email: over.email ?? `customer${counter}@real-customers.test`, created_at: over.created_at ?? OLD,
    cancelled_at: over.cancelled_at ?? null, data_deleted_at: over.data_deleted_at ?? null,
  });
  world.authUsers[id] = { last_sign_in_at: over.last_sign_in_at === undefined ? OLD : over.last_sign_in_at };
  return id;
}

const tmpDirs = [];
function tmpAudit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-audit-"));
  tmpDirs.push(dir);
  return path.join(dir, "audit.log");
}
const LIVE_ENV = { INACTIVITY_PURGE_ENABLED: "true" };

// ---------------------------------------------------------------- tiny runner
let passed = 0;
let failed = 0;
async function t(label, fn) {
  try { await fn(); passed++; console.log("PASS:", label); } catch (e) { failed++; console.error("FAIL:", label, "-", e.message); }
}

async function main() {
  // ---- cutoff
  await t("cutoff is now minus 6 calendar months", () => {
    assert.equal(computeCutoff(NOW).toISOString(), CUTOFF_ISO);
  });
  await t("cutoff clamps to the end of a shorter month (31 Aug -> 28 Feb, 31 Mar -> 30 Sep)", () => {
    assert.equal(computeCutoff(new Date("2026-08-31T00:00:00.000Z")).toISOString(), "2026-02-28T00:00:00.000Z");
    assert.equal(computeCutoff(new Date("2026-03-31T00:00:00.000Z")).toISOString(), "2025-09-30T00:00:00.000Z");
  });

  // ---- eligibility boundary
  await t("5 months 29 days inactive is NOT eligible", async () => {
    const w = makeWorld(); addAccount(w, { created_at: OLD, last_sign_in_at: FIVE_M_29_D });
    const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW });
    assert.equal(r.eligibleCount, 0);
  });
  await t("6 months 1 day inactive IS eligible", async () => {
    const w = makeWorld(); addAccount(w, { created_at: SIX_M_1_D, last_sign_in_at: SIX_M_1_D });
    const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW });
    assert.equal(r.eligibleCount, 1);
  });

  // ---- every signal newer than the cutoff blocks
  const signals = [
    ["scheduled_posts", "created_at"], ["scheduled_posts", "updated_at"], ["scheduled_posts", "scheduled_for"],
    ["post_results", "created_at"], ["api_keys", "last_used_at"], ["api_keys", "created_at"], ["wallet_ledger", "created_at"],
    ["wallet_lots", "granted_at"], ["social_accounts", "connected_at"], ["social_accounts", "disconnected_at"],
    ["whatsapp_chat_messages", "occurred_at"], ["whatsapp_conversations", "last_message_at"], ["media_uploads", "created_at"],
    ["billing_records", "created_at"],
  ];
  for (const [table, col] of signals) {
    await t(`a ${table}.${col} newer than the cutoff blocks the purge (and an older one does not)`, async () => {
      for (const [stamp, expected] of [[FIVE_M_29_D, 0], [SIX_M_1_D, 1]]) {
        const w = makeWorld(); const id = addAccount(w);
        w.tables[table].push({ account_id: id, [col]: stamp });
        const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW });
        assert.equal(r.eligibleCount, expected, `${stamp} should give ${expected}`);
      }
    });
  }
  await t("a recent sign-in blocks; a recent account creation blocks", async () => {
    const w1 = makeWorld(); addAccount(w1, { last_sign_in_at: "2026-09-01T00:00:00.000Z" });
    assert.equal((await runInactivityPurgeSweep(makeFake(w1), { now: NOW })).eligibleCount, 0);
    const w2 = makeWorld(); addAccount(w2, { created_at: "2026-09-01T00:00:00.000Z" });
    assert.equal((await runInactivityPurgeSweep(makeFake(w2), { now: NOW })).eligibleCount, 0);
  });
  await t("a post scheduled for the future blocks", async () => {
    const w = makeWorld(); const id = addAccount(w);
    w.tables.scheduled_posts.push({ account_id: id, created_at: OLD, updated_at: OLD, scheduled_for: "2026-12-01T00:00:00.000Z" });
    assert.equal((await runInactivityPurgeSweep(makeFake(w), { now: NOW })).eligibleCount, 0);
  });

  // ---- unreadable signal blocks (fail safe)
  const unreadable = [...new Set(signals.map(([tbl]) => tbl)), "subscriptions", "wallet_legacy_accounts"];
  for (const table of unreadable) {
    await t(`an unreadable ${table} makes the account ACTIVE (not eligible) and is reported with the raw error`, async () => {
      const w = makeWorld(); addAccount(w);
      w.errors[`select:${table}`] = `boom reading ${table}`;
      const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW });
      assert.equal(r.eligibleCount, 0);
      assert.ok(r.unreadableCount >= 1, "unreadableCount");
      assert.ok(JSON.stringify(r.unreadableErrors).includes(`boom reading ${table}`), "raw error is surfaced");
    });
  }
  await t("an unreadable sign-in time makes the account ACTIVE", async () => {
    const w = makeWorld(); addAccount(w); w.errors["auth:getUserById"] = "auth down";
    const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW });
    assert.equal(r.eligibleCount, 0);
    assert.ok(JSON.stringify(r.unreadableErrors).includes("auth down"));
  });
  await t("a missing auth user is treated as unreadable, not as inactive", async () => {
    const w = makeWorld(); const id = addAccount(w); delete w.authUsers[id];
    assert.equal((await runInactivityPurgeSweep(makeFake(w), { now: NOW })).eligibleCount, 0);
  });

  // ---- accounts that are never eligible
  const never = [
    ["a Growth subscription", (w, id) => w.tables.subscriptions.push({ account_id: id, tier: "growth", status: "active" })],
    ["a Pro subscription", (w, id) => w.tables.subscriptions.push({ account_id: id, tier: "pro", status: "active" })],
    ["an active subscription", (w, id) => w.tables.subscriptions.push({ account_id: id, tier: "starter", status: "active" })],
    ["a trialing subscription", (w, id) => w.tables.subscriptions.push({ account_id: id, tier: "starter", status: "trialing" })],
    ["a past_due subscription", (w, id) => w.tables.subscriptions.push({ account_id: id, tier: "starter", status: "past_due" })],
    ["a cancelled subscription (the 30-day job owns it)", (w, id) => w.tables.subscriptions.push({ account_id: id, tier: "starter", status: "cancelled" })],
    ["accounts.cancelled_at set", (w, id) => { w.tables.accounts.find((a) => a.id === id).cancelled_at = OLD; }],
    ["accounts.data_deleted_at set", (w, id) => { w.tables.accounts.find((a) => a.id === id).data_deleted_at = OLD; }],
    ["a wallet_legacy_accounts row", (w, id) => w.tables.wallet_legacy_accounts.push({ account_id: id })],
    ["an internal @lazyrelay.com email", (w, id) => { w.tables.accounts.find((a) => a.id === id).email = "someone@lazyrelay.com"; }],
    ["the owner's own email", (w, id) => { w.tables.accounts.find((a) => a.id === id).email = "goss.werner.1@gmail.com"; }],
    ["an example.com test email", (w, id) => { w.tables.accounts.find((a) => a.id === id).email = "x@example.com"; }],
  ];
  for (const [label, mutate] of never) {
    await t(`never eligible: ${label}`, async () => {
      const w = makeWorld(); const id = addAccount(w); mutate(w, id);
      const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW, live: true, env: LIVE_ENV, auditLog: tmpAudit() });
      assert.equal(r.eligibleCount, 0);
      assert.equal(r.deleted, 0);
      assert.equal(w.tables.accounts.length, 1);
    });
  }

  // ---- safety gates
  await t("dry run (default) deletes nothing and reports the eligible count", async () => {
    const w = makeWorld(); addAccount(w); addAccount(w);
    const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW });
    assert.equal(r.mode, "dry_run");
    assert.equal(r.eligibleCount, 2);
    assert.equal(r.deleted, 0);
    assert.equal(w.tables.accounts.length, 2);
    assert.deepEqual(w.calls.deletes, []);
    assert.deepEqual(w.calls.authDeleted, []);
  });
  for (const flag of [undefined, "", "TRUE", "1", "yes", " true"]) {
    await t(`live without the exact env flag (${JSON.stringify(flag)}) deletes nothing`, async () => {
      const w = makeWorld(); addAccount(w);
      const env = flag === undefined ? {} : { INACTIVITY_PURGE_ENABLED: flag };
      const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW, live: true, env, auditLog: tmpAudit() });
      assert.equal(r.mode, "dry_run");
      assert.equal(r.liveRequestedButDisabled, true);
      assert.equal(r.deleted, 0);
      assert.equal(w.tables.accounts.length, 1);
    });
  }
  await t("the env flag alone (without live:true) deletes nothing", async () => {
    const w = makeWorld(); addAccount(w);
    const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW, env: LIVE_ENV });
    assert.equal(r.deleted, 0);
    assert.equal(w.tables.accounts.length, 1);
  });
  await t("live + flag deletes the account (account row, content, auth user) and appends one audit line without customer content", async () => {
    const w = makeWorld(); const id = addAccount(w, { email: "secret.person@real-customers.test" });
    w.tables.media_uploads.push({ account_id: id, storage_path: "a/b.png", created_at: OLD });
    w.tables.scheduled_posts.push({ account_id: id, content: "private caption", created_at: OLD, updated_at: OLD, scheduled_for: OLD });
    w.tables.social_accounts.push({ id: "sa1", account_id: id, connected_at: OLD, access_token_vault_id: "v1", refresh_token_vault_id: "v2" });
    const auditLog = tmpAudit();
    const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW, live: true, env: LIVE_ENV, auditLog });
    assert.equal(r.mode, "live");
    assert.equal(r.deleted, 1);
    assert.equal(w.tables.accounts.length, 0);
    assert.equal(w.tables.scheduled_posts.length, 0);
    assert.deepEqual(w.calls.removed, ["a/b.png"]);
    assert.deepEqual(w.calls.authDeleted, [id]);
    const vaultWipes = w.calls.rpc.filter((c) => c.name === "update_social_token").map((c) => c.args.p_vault_id).sort();
    assert.deepEqual(vaultWipes, ["v1", "v2"]);
    const lines = fs.readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event === "inactivity_purge_deleted");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].accountId, id);
    assert.ok(lines[0].plan && lines[0].lastActivityAt && lines[0].deletedAt);
    const raw = fs.readFileSync(auditLog, "utf8");
    assert.ok(!raw.includes("secret.person") && !raw.includes("private caption"), "no customer content in the audit log");
  });
  await t("live without an audit log path refuses and deletes nothing", async () => {
    const w = makeWorld(); addAccount(w);
    await assert.rejects(runInactivityPurgeSweep(makeFake(w), { now: NOW, live: true, env: LIVE_ENV }), /auditLog/);
    assert.equal(w.tables.accounts.length, 1);
  });
  await t("per-run cap: maxPerRun 2 deletes exactly 2 of 4 eligible, and a re-run finishes the rest (idempotent)", async () => {
    const w = makeWorld(); for (let i = 0; i < 4; i++) addAccount(w);
    const fake = makeFake(w); const auditLog = tmpAudit();
    const base = { now: NOW, live: true, env: LIVE_ENV, auditLog, maxPerRun: 2, approvedEligibleCount: 4 };
    const r1 = await runInactivityPurgeSweep(fake, base);
    assert.equal(r1.deleted, 2); assert.equal(w.tables.accounts.length, 2);
    const r2 = await runInactivityPurgeSweep(fake, base);
    assert.equal(r2.deleted, 2); assert.equal(w.tables.accounts.length, 0);
    const r3 = await runInactivityPurgeSweep(fake, base);
    assert.equal(r3.deleted, 0); assert.equal(r3.eligibleCount, 0);
  });
  await t("default cap is 25 per run", async () => {
    const w = makeWorld(); for (let i = 0; i < 25; i++) addAccount(w);
    const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW, live: true, env: LIVE_ENV, auditLog: tmpAudit(), maxPerRun: 100 });
    assert.ok(r.deleted <= 25);
    assert.equal(purge.DEFAULT_MAX_PER_RUN, 25);
  });
  await t("more than 25 eligible on first sight aborts with too_many_eligible, in dry run", async () => {
    const w = makeWorld(); for (let i = 0; i < 26; i++) addAccount(w);
    const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW });
    assert.equal(r.aborted, "too_many_eligible");
    assert.equal(r.eligibleCount, 26);
    assert.equal(w.tables.accounts.length, 26);
  });
  await t("more than 25 eligible aborts in live mode too (nothing deleted) until a human approves the count", async () => {
    const w = makeWorld(); for (let i = 0; i < 26; i++) addAccount(w);
    const fake = makeFake(w);
    const r = await runInactivityPurgeSweep(fake, { now: NOW, live: true, env: LIVE_ENV, auditLog: tmpAudit() });
    assert.equal(r.aborted, "too_many_eligible");
    assert.equal(w.tables.accounts.length, 26);
    const approved = await runInactivityPurgeSweep(fake, { now: NOW, live: true, env: LIVE_ENV, auditLog: tmpAudit(), approvedEligibleCount: 26, maxPerRun: 3 });
    assert.equal(approved.aborted, undefined);
    assert.equal(approved.deleted, 3);
  });
  await t("exactly 25 eligible does not abort", async () => {
    const w = makeWorld(); for (let i = 0; i < 25; i++) addAccount(w);
    const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW });
    assert.equal(r.aborted, undefined);
    assert.equal(r.eligibleCount, 25);
  });

  // ---- live re-check and errors
  await t("an account that became active after the scan is NOT deleted (live re-check)", async () => {
    const w = makeWorld(); const id = addAccount(w);
    const fake = makeFake(w);
    w.tables.scheduled_posts.push({ account_id: id, created_at: "2026-10-20T00:00:00.000Z", updated_at: OLD, scheduled_for: OLD });
    const res = await purgeAccount(fake, { id, email: "x@real-customers.test", created_at: OLD }, { now: NOW, cutoff: computeCutoff(NOW), auditLog: tmpAudit() });
    assert.equal(res.deleted, false);
    assert.equal(w.tables.accounts.length, 1);
  });
  await t("a failing delete surfaces the raw error in deletionErrors and the run does not pretend it deleted", async () => {
    const w = makeWorld(); addAccount(w);
    w.errors["delete:accounts"] = "fk violation xyz";
    const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW, live: true, env: LIVE_ENV, auditLog: tmpAudit() });
    assert.equal(r.deleted, 0);
    assert.equal(r.deletionErrors.length, 1);
    assert.ok(r.deletionErrors[0].error.includes("fk violation xyz"));
  });
  await t("a failing login wipe stops that account's deletion and surfaces the error", async () => {
    const w = makeWorld(); const id = addAccount(w);
    w.tables.social_accounts.push({ id: "sa1", account_id: id, connected_at: OLD, access_token_vault_id: "v1", refresh_token_vault_id: null });
    w.errors["rpc:update_social_token"] = "vault offline";
    const r = await runInactivityPurgeSweep(makeFake(w), { now: NOW, live: true, env: LIVE_ENV, auditLog: tmpAudit() });
    assert.equal(r.deleted, 0);
    assert.ok(r.deletionErrors[0].error.includes("vault offline"));
    assert.equal(w.tables.accounts.length, 1);
    assert.deepEqual(w.calls.authDeleted, []);
  });
  await t("a failing candidate listing throws (no silent swallow)", async () => {
    const w = makeWorld(); addAccount(w); w.errors["select:accounts"] = "accounts unreadable";
    await assert.rejects(runInactivityPurgeSweep(makeFake(w), { now: NOW }), /accounts unreadable/);
  });
  await t("the wallet ledger history survives account deletion (no foreign key by design)", async () => {
    const w = makeWorld(); const id = addAccount(w);
    w.tables.wallet_ledger.push({ account_id: id, created_at: OLD });
    await runInactivityPurgeSweep(makeFake(w), { now: NOW, live: true, env: LIVE_ENV, auditLog: tmpAudit() });
    assert.equal(w.tables.accounts.length, 0);
    assert.equal(w.tables.wallet_ledger.length, 1);
  });
  await t("the summary is compact: no emails or ids unless detail:true", async () => {
    const w = makeWorld(); const id = addAccount(w, { email: "findme@real-customers.test" });
    const plain = JSON.stringify(await runInactivityPurgeSweep(makeFake(w), { now: NOW }));
    assert.ok(!plain.includes("findme@") && !plain.includes(id));
    const detailed = await runInactivityPurgeSweep(makeFake(w), { now: NOW, detail: true });
    assert.ok(!JSON.stringify(detailed).includes("findme@"));
    assert.equal(detailed.eligible[0].accountId, id);
  });

  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error("Test run threw:", err); process.exit(1); });
