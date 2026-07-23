// One-off smoke test — proves the downgrade-pause enforcement added in
// migration 0013_social_accounts_paused.sql actually works against the real
// Supabase project: planDowngradePause() picks the right accounts,
// enforceDowngradePause() sets paused_at, a paused account is excluded from
// the "keep" set on a re-plan, and unpauseAccounts() reverses it cleanly.
// Run: node ops/accounts/test-downgrade-pause.js

const { getSupabaseClient } = require("../shared/supabaseClient.js");
const { planDowngradePause, enforceDowngradePause, unpauseAccounts } = require("./accounts_ops.js");

async function main() {
  const supabase = getSupabaseClient();
  const email = `downgrade-pause-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  let pass = true;
  const socialAccountIds = [];
  for (let i = 0; i < 3; i++) {
    const { data: vaultId } = await supabase.rpc("store_social_token", { p_token: `tok-${i}` });
    const { data: sa } = await supabase
      .from("social_accounts")
      .insert({
        account_id: accountId,
        platform: "meta",
        platform_account_id: `page-${i}-${Date.now()}`,
        display_name: `Test Page ${i}`,
        access_token_vault_id: vaultId,
      })
      .select("id")
      .single();
    socialAccountIds.push(sa.id);
    await new Promise((r) => setTimeout(r, 20)); // ensure distinct connected_at ordering
  }
  console.log(`Connected 3 test accounts, oldest-first: ${socialAccountIds.join(", ")}`);

  // Downgrade to a limit of 1 — expect 2 pause candidates, the 2 newest.
  const plan = await planDowngradePause(supabase, accountId, 1);
  if (plan.pauseCandidates.length !== 2 || plan.keep.length !== 1 || plan.keep[0].id !== socialAccountIds[0]) {
    console.error("FAIL: plan did not keep the oldest account and pause the other two.", plan);
    pass = false;
  } else {
    console.log("PASS: plan correctly keeps the oldest-connected account and flags the other two for pause.");
  }

  const { paused } = await enforceDowngradePause(supabase, plan.pauseCandidates);
  const { data: afterEnforce } = await supabase
    .from("social_accounts")
    .select("id, paused_at")
    .in("id", socialAccountIds);
  const pausedNow = afterEnforce.filter((a) => a.paused_at !== null).map((a) => a.id);
  if (pausedNow.length !== 2 || !plan.pauseCandidates.every((c) => pausedNow.includes(c.id))) {
    console.error("FAIL: enforceDowngradePause did not set paused_at on the expected accounts.", afterEnforce);
    pass = false;
  } else {
    console.log("PASS: enforceDowngradePause set paused_at on exactly the planned accounts.");
  }

  // Re-planning now should return 0 new candidates — already-paused accounts are filtered out.
  const replan = await planDowngradePause(supabase, accountId, 1);
  if (replan.pauseCandidates.length !== 0) {
    console.error("FAIL: re-running planDowngradePause should not re-flag already-paused accounts.", replan);
    pass = false;
  } else {
    console.log("PASS: re-planning is idempotent — already-paused accounts aren't re-flagged.");
  }

  const { unpaused } = await unpauseAccounts(supabase, paused);
  const { data: afterUnpause } = await supabase
    .from("social_accounts")
    .select("id, paused_at")
    .in("id", unpaused);
  if (!afterUnpause.every((a) => a.paused_at === null)) {
    console.error("FAIL: unpauseAccounts did not clear paused_at.", afterUnpause);
    pass = false;
  } else {
    console.log("PASS: unpauseAccounts cleared paused_at on all reversed accounts.");
  }

  await supabase.from("social_accounts").delete().in("id", socialAccountIds);
  await supabase.auth.admin.deleteUser(accountId);

  console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
