// Live verification of inactivity_purge_ops.js against a THROWAWAY Supabase branch only. Never run it against production.
// It refuses to start unless it is handed a branch explicitly: it never falls back to ops/config/credentials.js, so it cannot
// reach the production project by accident. Required environment (all four, set by hand for the run):
//   PURGE_LIVE_TEST_SUPABASE_URL            https://<branch-ref>.supabase.co
//   PURGE_LIVE_TEST_SERVICE_ROLE_KEY        that branch's service role key
//   PURGE_LIVE_TEST_BRANCH_REF              the branch ref, must equal the subdomain of the URL (typed twice on purpose)
//   PURGE_LIVE_TEST_IS_NOT_PRODUCTION=yes   written confirmation that the project is a disposable branch
// The branch needs all migrations applied. Seeds throwaway accounts with *.invalid addresses, runs the real sweep (dry run,
// then live with the env flag set only inside this process), checks the results, and deletes whatever is left.
// Run: node ops/tests/test-inactivity-purge-live.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const url = process.env.PURGE_LIVE_TEST_SUPABASE_URL;
const key = process.env.PURGE_LIVE_TEST_SERVICE_ROLE_KEY;
const ref = process.env.PURGE_LIVE_TEST_BRANCH_REF;
if (!url || !key || !ref || process.env.PURGE_LIVE_TEST_IS_NOT_PRODUCTION !== "yes") {
  console.error("Refusing to run: set PURGE_LIVE_TEST_SUPABASE_URL, _SERVICE_ROLE_KEY, _BRANCH_REF and PURGE_LIVE_TEST_IS_NOT_PRODUCTION=yes for a throwaway branch.");
  process.exit(2);
}
if (new URL(url).hostname.split(".")[0] !== ref) {
  console.error("Refusing to run: PURGE_LIVE_TEST_BRANCH_REF does not match the URL's project ref.");
  process.exit(2);
}

const { createClient } = require("@supabase/supabase-js"); // loaded only after the branch guards pass
const { runInactivityPurgeSweep } = require("../accounts/inactivity_purge_ops.js");
const supabase = createClient(url, key, { auth: { persistSession: false } });
const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

async function seed(label, createdDaysAgo, { postDaysAgo } = {}) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@purge-fixture.invalid`;
  const { data: user, error } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (error || !user.user) throw error ?? new Error("no user created");
  const id = user.user.id;
  const { error: upErr } = await supabase.from("accounts").update({ created_at: daysAgo(createdDaysAgo) }).eq("id", id);
  if (upErr) throw upErr;
  if (postDaysAgo !== undefined) {
    const { data: vaultId, error: vErr } = await supabase.rpc("store_social_token", { p_token: `purge-test-${Math.random()}` });
    if (vErr) throw vErr;
    const { data: social, error: sErr } = await supabase.from("social_accounts").insert({
      account_id: id, platform: "meta", platform_account_id: `purge-test-${Math.random()}`, display_name: "Purge Test", access_token_vault_id: vaultId,
    }).select("id").single();
    if (sErr) throw sErr;
    const { error: pErr } = await supabase.from("scheduled_posts").insert({
      account_id: id, social_account_id: social.id, content: "throwaway", scheduled_for: daysAgo(postDaysAgo), created_at: daysAgo(postDaysAgo),
    });
    if (pErr) throw pErr;
  }
  return id;
}

async function exists(id) {
  const { data } = await supabase.from("accounts").select("id").eq("id", id).maybeSingle();
  return !!data;
}

(async () => {
  const results = [];
  const created = [];
  try {
    const old = await seed("old", 400); created.push(old);
    const recentPost = await seed("recent-post", 400, { postDaysAgo: 30 }); created.push(recentPost);
    const young = await seed("young", 10); created.push(young);
    const auditLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "purge-live-")), "audit.log");

    // The branch may hold other old accounts; approve whatever count the dry run reports so the test can proceed.
    const dry = await runInactivityPurgeSweep(supabase, { detail: true });
    const dryIds = (dry.eligible ?? []).map((e) => e.accountId);
    results.push({ test: "dry run lists the old account, not the recent-post or young account, and deletes nothing", PASS: dryIds.includes(old) && !dryIds.includes(recentPost) && !dryIds.includes(young) && (await exists(old)) });

    const blockedRun = await runInactivityPurgeSweep(supabase, { live: true, auditLog, env: {} });
    results.push({ test: "live without the env flag deletes nothing", PASS: blockedRun.deleted === 0 && (await exists(old)) });

    const live = await runInactivityPurgeSweep(supabase, { live: true, auditLog, env: { INACTIVITY_PURGE_ENABLED: "true" }, approvedEligibleCount: dry.eligibleCount, maxPerRun: Math.max(dry.eligibleCount, 1) });
    results.push({ test: "live with the flag deletes the old account and keeps the others", PASS: live.deleted >= 1 && !(await exists(old)) && (await exists(recentPost)) && (await exists(young)), live });
    const { data: users } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    results.push({ test: "the auth user of the deleted account is gone", PASS: !users.users.some((u) => u.id === old) });
    results.push({ test: "an audit line was written", PASS: fs.readFileSync(auditLog, "utf8").includes(old) });
  } finally {
    for (const id of created) { try { await supabase.auth.admin.deleteUser(id); } catch { /* already deleted by the code under test */ } }
  }
  console.log(JSON.stringify(results, null, 2));
  const ok = results.every((r) => r.PASS);
  console.log(ok ? "\nALL TESTS PASS" : "\nSOME TESTS FAILED");
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error("Live test threw:", err); process.exit(1); });
