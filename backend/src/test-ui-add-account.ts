import "dotenv/config";
import { supabase } from "./supabase.js";

// Adds a stub social_account row for the UI test fixture user so the
// Dashboard's scheduling form has something to select. Pass the account id
// as argv[2].
async function main() {
  const accountId = process.argv[2];
  if (!accountId) throw new Error("usage: test-ui-add-account.ts <account_id>");

  const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
    p_token: "ui-test-stub-token",
  });
  if (vaultError) throw vaultError;

  const { data, error } = await supabase
    .from("social_accounts")
    .insert({
      account_id: accountId,
      platform: "meta",
      platform_account_id: "ui-test-page",
      display_name: "UI Test Page",
      access_token_vault_id: vaultId,
    })
    .select()
    .single();
  if (error) throw error;
  console.log(JSON.stringify(data));
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
