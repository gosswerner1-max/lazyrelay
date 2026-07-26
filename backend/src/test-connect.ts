import "dotenv/config";
import { supabase } from "./supabase.js";
import { StubAdapter } from "./platforms/stub.js";
import { startConnect, completeConnect } from "./platforms/connect.js";

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
  const authorizeUrl = await startConnect(accountId, adapter.platform, registry);
  console.log("Authorize URL:", authorizeUrl);
  const state = new URL(authorizeUrl).searchParams.get("state");
  if (!state) throw new Error("no state param in authorize URL");

  // Simulate the platform's callback with that real state + a fake code.
  const socialAccountId = await completeConnect(state, "fake-oauth-code", registry);

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
  console.log(`[connect succeeds] -> ${pass1 ? "PASS" : "FAIL"}`);

  // Real security check: the state should be consumed (one-time use) —
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

  console.log(pass1 && replayFailed ? "ALL PASS" : "SOME FAILED");
  process.exit(pass1 && replayFailed ? 0 : 1);
}

main().catch((err) => {
  console.error("Connect test failed:", err);
  process.exit(1);
});
