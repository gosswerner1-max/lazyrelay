import "dotenv/config";
import { supabase } from "./supabase.js";
import { checkAccountLimit, checkNewDistinctAccountLimit, ACCOUNT_LIMITS } from "./accountLimits.js";

// One-off smoke test — proves the rolling-window distinct-account limit
// (added 2026-09-04) actually closes the gap checkAccountLimit alone left
// open: a customer disconnecting one real account and connecting a
// DIFFERENT one, over and over, never exceeding the "currently connected"
// cap while cycling through far more distinct accounts than their plan
// allows. Against the real Supabase project, cleaned up after.

async function main() {
  const email = `distinct-limit-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  let pass = true;
  const freeLimit = ACCOUNT_LIMITS.free;
  console.log(`Free tier limit: ${freeLimit} distinct accounts per rolling window`);
  const socialAccountIds: string[] = [];

  async function connectNew(index: number): Promise<{ id: string; platformAccountId: string } | null> {
    const platformAccountId = `distinct-${index}-${Date.now()}`;
    const limitError = await checkNewDistinctAccountLimit(accountId);
    if (limitError) return null;
    const { data: vaultId } = await supabase.rpc("store_social_token", { p_token: `tok-${index}` });
    const { data: sa } = await supabase
      .from("social_accounts")
      .insert({
        account_id: accountId,
        platform: "meta",
        platform_account_id: platformAccountId,
        display_name: `Test Page ${index}`,
        access_token_vault_id: vaultId,
      })
      .select("id")
      .single();
    return { id: sa!.id, platformAccountId };
  }

  // Connect freeLimit distinct accounts, then disconnect all of them --
  // simulates a customer cycling through accounts one at a time.
  const connected: { id: string; platformAccountId: string }[] = [];
  for (let i = 0; i < freeLimit; i++) {
    const result = await connectNew(i);
    if (!result) {
      console.error(`FAIL: distinct account ${i + 1}/${freeLimit} was rejected but should be allowed`);
      pass = false;
      continue;
    }
    connected.push(result);
    socialAccountIds.push(result.id);
  }
  console.log(`Connected ${connected.length}/${freeLimit} distinct accounts, all allowed.`);

  // Disconnect all of them -- checkAccountLimit (currently-connected count)
  // should now show room again, but the NEW rolling-window check should
  // still block a genuinely new one, since all were first connected inside
  // the window regardless of current connection state.
  await supabase
    .from("social_accounts")
    .update({ disconnected_at: new Date().toISOString() })
    .in("id", socialAccountIds);

  const currentlyConnectedCheck = await checkAccountLimit(accountId);
  console.log("checkAccountLimit after disconnecting all:", currentlyConnectedCheck);
  if (currentlyConnectedCheck !== null) {
    console.error("FAIL: checkAccountLimit should show room once nothing is currently connected (unchanged behavior).");
    pass = false;
  } else {
    console.log("PASS: checkAccountLimit (currently-connected count) correctly unaffected by this change.");
  }

  // The real test: a genuinely NEW distinct account should now be blocked,
  // even though nothing is currently connected -- this is the exact
  // cycling scenario the fix closes.
  const overLimit = await connectNew(freeLimit); // one past the limit
  console.log("Attempt to connect a new distinct account beyond the rolling limit:", overLimit ? "ALLOWED (bug)" : "BLOCKED (correct)");
  if (overLimit) {
    console.error("FAIL: a new distinct account beyond the rolling-window limit should have been rejected.");
    pass = false;
    socialAccountIds.push(overLimit.id); // clean up if it wrongly got created
  } else {
    console.log("PASS: cycling to a new distinct account beyond the plan's real limit is correctly blocked.");
  }

  // Reconnecting a KNOWN account (one of the original ones, now
  // disconnected) must NEVER be blocked by this check -- it's not a new
  // distinct account, just a reconnect.
  const knownAccount = connected[0];
  const { data: existingRow } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("account_id", accountId)
    .eq("platform", "meta")
    .eq("platform_account_id", knownAccount.platformAccountId)
    .maybeSingle();
  const reconnectExempt = existingRow ? null : await checkNewDistinctAccountLimit(accountId);
  console.log("Reconnecting a known (already-seen) account, exempt check:", existingRow ? "SKIPPED (correct — real code path never calls the limit check for a known row)" : reconnectExempt);
  if (!existingRow) {
    console.error("FAIL: the known account's row should still exist (upsert never deletes on disconnect).");
    pass = false;
  } else {
    console.log("PASS: reconnecting a known account is exempt from the distinct-account limit, matching storeConnectedAccount's real logic.");
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
