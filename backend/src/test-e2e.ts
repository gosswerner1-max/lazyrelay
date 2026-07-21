import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
import { StubAdapter } from "./platforms/stub.js";

// One-off manual smoke test — not part of the app, just proving the schema
// + scheduler actually work end to end against the real Supabase project
// before treating this as "done." Deletable once real integration tests exist.
async function main() {
  const email = `e2e-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;

  const { error: accountError } = await supabase
    .from("accounts")
    .insert({ id: accountId, email });
  if (accountError) throw accountError;

  const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
    p_token: "test-access-token-value",
  });
  if (vaultError) throw vaultError;

  const { data: socialAccount, error: socialError } = await supabase
    .from("social_accounts")
    .insert({
      account_id: accountId,
      platform: "meta",
      platform_account_id: "test-page-123",
      display_name: "Test Page",
      access_token_vault_id: vaultId,
    })
    .select()
    .single();
  if (socialError || !socialAccount) throw socialError;

  const { data: post, error: postError } = await supabase
    .from("scheduled_posts")
    .insert({
      account_id: accountId,
      social_account_id: socialAccount.id,
      content: "End-to-end test post",
      scheduled_for: new Date(Date.now() - 1000).toISOString(), // already due
    })
    .select()
    .single();
  if (postError || !post) throw postError;

  console.log("Seeded test data. Running scheduler cycle...");
  await runSchedulerCycle(new StubAdapter());

  const { data: finalPost } = await supabase
    .from("scheduled_posts")
    .select("status")
    .eq("id", post.id)
    .single();
  const { data: result } = await supabase
    .from("post_results")
    .select("*")
    .eq("scheduled_post_id", post.id)
    .single();

  console.log("Final post status:", finalPost?.status);
  console.log("Post result row:", result);

  // Cleanup
  await supabase.auth.admin.deleteUser(accountId);
  console.log(finalPost?.status === "posted" && result?.verified_live ? "PASS" : "FAIL");
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
