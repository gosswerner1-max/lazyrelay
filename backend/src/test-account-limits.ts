import "dotenv/config";
import { supabase } from "./supabase.js";
import { checkAccountLimit, ACCOUNT_LIMITS } from "./accountLimits.js";

// One-off smoke test — proves the new per-tier account-limit enforcement
// (added 2026-07-23 alongside the Starter/Pro/Business restructure) works
// against the real Supabase project. Before this, account limits existed
// only as marketing copy — nothing in the code actually enforced them.

async function main() {
  const email = `account-limit-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  let pass = true;
  const freeLimit = ACCOUNT_LIMITS.free;
  console.log(`Free tier limit: ${freeLimit} accounts`);

  // Connect up to the limit — each should be allowed.
  const socialAccountIds: string[] = [];
  for (let i = 0; i < freeLimit; i++) {
    const before = await checkAccountLimit(accountId);
    if (before !== null) {
      console.error(`FAIL: account ${i + 1}/${freeLimit} was rejected but should be allowed: ${before}`);
      pass = false;
    }
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
    socialAccountIds.push(sa!.id);
  }
  console.log(`Connected ${socialAccountIds.length}/${freeLimit} accounts, all allowed.`);

  // The next one (over the limit) should be rejected.
  const overLimit = await checkAccountLimit(accountId);
  console.log("Check after reaching the limit:", overLimit);
  if (!overLimit || !overLimit.includes(String(freeLimit))) {
    console.error("FAIL: expected a rejection mentioning the limit once at capacity.");
    pass = false;
  } else {
    console.log("PASS: correctly rejected once at the free-tier account limit.");
  }

  // Disconnect one — should free up a slot again.
  await supabase.from("social_accounts").update({ disconnected_at: new Date().toISOString() }).eq("id", socialAccountIds[0]);
  const afterDisconnect = await checkAccountLimit(accountId);
  console.log("Check after disconnecting one:", afterDisconnect);
  if (afterDisconnect !== null) {
    console.error("FAIL: expected room for one more account after a disconnect.");
    pass = false;
  } else {
    console.log("PASS: disconnecting an account correctly frees up a slot.");
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
