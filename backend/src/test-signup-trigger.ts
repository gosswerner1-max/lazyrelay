import "dotenv/config";
import { supabase } from "./supabase.js";

// Proves the 0005_account_on_signup.sql trigger actually fires: creates an
// auth user WITHOUT manually inserting into accounts (unlike every other
// test script here), then checks the accounts row was created automatically.
async function main() {
  const email = `signup-trigger-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;

  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("*")
    .eq("id", accountId)
    .single();

  console.log("Account row created by trigger:", account);
  if (accountError) console.log("Account query error:", accountError);

  await supabase.auth.admin.deleteUser(accountId);
  console.log(account?.email === email ? "PASS" : "FAIL");
}

main().catch((err) => {
  console.error("Signup trigger test failed:", err);
  process.exit(1);
});
