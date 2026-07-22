import "dotenv/config";
import { supabase } from "./supabase.js";

// One-off manual setup — creates a real, email-confirmed test account with
// a connected (stub) social account, so we can log into the live site and
// click through the real Paddle sandbox checkout by hand. Does NOT clean
// up afterward (unlike test-e2e.ts/test-free-tier-limit.ts) since we want
// the account to stick around for the manual walkthrough.
async function main() {
  const email = `paddle-upgrade-test-${Date.now()}@lazyrelay.invalid`;
  const password = "test-password-not-real-123";

  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;

  const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
    p_token: "test-access-token-value",
  });
  if (vaultError) throw vaultError;

  const { data: socialAccount, error: socialError } = await supabase
    .from("social_accounts")
    .insert({
      account_id: accountId,
      platform: "meta",
      platform_account_id: `paddle-upgrade-test-page-${Date.now()}`,
      display_name: "Paddle Upgrade Test Page",
      access_token_vault_id: vaultId,
    })
    .select()
    .single();
  if (socialError || !socialAccount) throw socialError;

  console.log(JSON.stringify({ email, password, accountId, socialAccountId: socialAccount.id }, null, 2));
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
