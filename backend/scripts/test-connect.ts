import "dotenv/config";
import { supabase } from "../src/supabase.js";
import { StubAdapter } from "../src/platforms/stub.js";
import { startConnect, completeConnect, getPendingSelection, finalizeConnectSelection } from "../src/platforms/connect.js";

async function main() {
  const email = `connect-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user");
  const accountId = user.user.id;
  await supabase.from("accounts").insert({ id: accountId, email });

  const adapter = new StubAdapter();
  const registry = new Map([[adapter.platform, adapter]]);

  // Start the flow — should return a real authorize URL containing a state token.
  const { url: authorizeUrl } = await startConnect(accountId, adapter.platform, registry);
  console.log("Authorize URL:", authorizeUrl);
  const state = new URL(authorizeUrl).searchParams.get("state");
  if (!state) throw new Error("no state param in authorize URL");

  // Simulate the platform's callback with that real state + a fake code. The stub has no
  // listConnectOptions, so the login is exchanged and HELD: nothing is saved yet, the customer
  // must confirm which account it is (needs_selection with exactly one option).
  const connectResult = await completeConnect(state, "fake-oauth-code", registry);
  if (connectResult.status !== "needs_selection" || connectResult.options.length !== 1) {
    throw new Error(`Expected one account to confirm, got ${JSON.stringify(connectResult)}`);
  }
  const heldNothingSaved = (await supabase.from("social_accounts").select("id").eq("account_id", accountId)).data?.length === 0;
  console.log(`[login held until confirmed] -> ${heldNothingSaved ? "PASS" : "FAIL"}`);

  // The dashboard reads the pending option back, then the customer confirms it.
  const pending = await getPendingSelection(connectResult.selectionToken, accountId, registry);
  const [socialAccountId] = await finalizeConnectSelection(
    connectResult.selectionToken,
    [pending.options[0].id],
    accountId,
    registry,
  );

  const { data: socialAccount } = await supabase
    .from("social_accounts")
    .select("*")
    .eq("id", socialAccountId)
    .single();
  console.log("Created social_account:", socialAccount);

  const pass1 =
    socialAccount?.account_id === accountId &&
    socialAccount?.platform === "meta" &&
    socialAccount?.access_token_vault_id != null;
  console.log(`[connect succeeds after confirm] -> ${pass1 ? "PASS" : "FAIL"}`);

  // Real security check: the state is consumed by the confirmation (one-time use) —
  // trying to complete the same state again must fail, not silently
  // create a second social_account.
  let replayFailed = false;
  try {
    await completeConnect(state, "fake-oauth-code", registry);
  } catch {
    replayFailed = true;
  }
  console.log(`[state replay rejected] -> ${replayFailed ? "PASS" : "FAIL"}`);

  // Cleanup
  await supabase.from("social_accounts").delete().eq("id", socialAccountId);
  await supabase.auth.admin.deleteUser(accountId);

  const allPass = heldNothingSaved && pass1 && replayFailed;
  console.log(allPass ? "ALL PASS" : "SOME FAILED");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("Connect test failed:", err);
  process.exit(1);
});
