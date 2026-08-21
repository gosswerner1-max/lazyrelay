import "dotenv/config";
import { supabase } from "./supabase.js";
import { runSchedulerCycle } from "./scheduler.js";
import { StubAdapter } from "./platforms/stub.js";

// Proves the 2026-08-21 fix in scheduler.ts's processPost(): a due post
// whose platform has no registered adapter used to get stuck permanently on
// status "posting" (claimDuePosts() claims it, then processPost bails
// before ever un-claiming it) — silently invisible to every future cycle,
// with no error surfaced anywhere. Found live when a test using a
// leftover/unregistered platform key ("meta") stalled a scheduler-cycle
// loop with no explanation. Fix: un-claim back to "pending" in that branch,
// same as the breaker/rate-limit paths already do.
async function main() {
  const email = `no-adapter-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;

  try {
    const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
      p_token: "test-access-token-value",
    });
    if (vaultError) throw vaultError;

    const { data: socialAccount, error: socialError } = await supabase
      .from("social_accounts")
      .insert({
        account_id: accountId,
        platform: "meta",
        platform_account_id: "no-adapter-test-page",
        display_name: "No-Adapter Test Page",
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
        content: "No-adapter unclaim test post",
        scheduled_for: new Date(Date.now() - 1000).toISOString(),
      })
      .select()
      .single();
    if (postError || !post) throw postError;

    console.log("Step 1: run a cycle with an EMPTY registry (no adapter for \"meta\") — post should bounce back to pending, not stick on posting.");
    await runSchedulerCycle(new Map());
    const { data: afterEmpty } = await supabase.from("scheduled_posts").select("status").eq("id", post.id).single();
    console.log(`  status after cycle 1: "${afterEmpty?.status}"`);
    const step1Pass = afterEmpty?.status === "pending";
    console.log(step1Pass ? "  PASS — correctly un-claimed back to pending." : "  FAIL — stuck, not pending.");

    console.log("Step 2: run a cycle with a REAL adapter now registered — proves the post isn't permanently broken, it processes normally once the platform exists.");
    const stubAdapter = new StubAdapter();
    await runSchedulerCycle(new Map([[stubAdapter.platform, stubAdapter]]));
    const { data: afterReal } = await supabase.from("scheduled_posts").select("status").eq("id", post.id).single();
    console.log(`  status after cycle 2: "${afterReal?.status}"`);
    const step2Pass = afterReal?.status === "posted";
    console.log(step2Pass ? "  PASS — posted normally once an adapter existed." : "  FAIL — did not post.");

    console.log(step1Pass && step2Pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
    if (!step1Pass || !step2Pass) process.exitCode = 1;
  } finally {
    await supabase.auth.admin.deleteUser(accountId);
  }
}

main().catch((err) => {
  console.error("No-adapter unclaim test failed:", err);
  process.exit(1);
});
