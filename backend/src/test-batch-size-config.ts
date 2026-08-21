import "dotenv/config";
import { spawnSync } from "node:child_process";
import { supabase } from "./supabase.js";

// Proves the 2026-08-21 change: SCHEDULER_CLAIM_BATCH_SIZE actually
// overrides the scheduler's claim batch size. Must run the scheduler cycle
// in a genuinely separate child process with the env var set in that
// process's environment BEFORE it starts — exactly how Render sets env
// vars (before the Node process boots), and the only way to actually test
// this, since CLAIM_BATCH_SIZE is a module-level constant read once at
// import time. Setting process.env in the same file before an `import`
// does NOT work: ES module imports are hoisted and resolve before any of
// this file's own top-level code runs (learned live — the first version of
// this test tried exactly that and silently fell back to the default 10).
async function main() {
  const email = `batch-size-config-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;

  try {
    const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
      p_token: "test-access-token-value",
    });
    if (vaultError) throw vaultError;

    const postIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { data: socialAccount, error: socialError } = await supabase
        .from("social_accounts")
        .insert({
          account_id: accountId,
          platform: "meta",
          platform_account_id: `batch-config-test-${i}`,
          display_name: `Batch Config Test ${i}`,
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
          content: `Batch config test post ${i}`,
          scheduled_for: new Date(Date.now() - 1000).toISOString(),
        })
        .select()
        .single();
      if (postError || !post) throw postError;
      postIds.push(post.id);
    }

    console.log("SCHEDULER_CLAIM_BATCH_SIZE=3 (set in a fresh child process's environment), 5 posts seeded and due. Running one cycle via a helper script — should claim exactly 3, not the default 10.");
    const result = spawnSync("npx tsx src/test-batch-size-config-runner.ts", {
      env: { ...process.env, SCHEDULER_CLAIM_BATCH_SIZE: "3" },
      cwd: process.cwd(),
      encoding: "utf8",
      shell: true,
    });
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);

    const { data: afterCycle } = await supabase.from("scheduled_posts").select("id, status").in("id", postIds);
    const posted = (afterCycle ?? []).filter((p) => p.status === "posted").length;
    const stillPending = (afterCycle ?? []).filter((p) => p.status === "pending").length;
    console.log(`  posted: ${posted}, still pending: ${stillPending}`);

    const pass = posted === 3 && stillPending === 2;
    console.log(pass ? "PASS — env override correctly limited the batch to 3." : "FAIL");
    if (!pass) process.exitCode = 1;
  } finally {
    await supabase.auth.admin.deleteUser(accountId);
  }
}

main().catch((err) => {
  console.error("Batch size config test failed:", err);
  process.exit(1);
});
