import "dotenv/config";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { supabase } from "./supabase.js";
import { MastodonAdapter } from "./platforms/mastodon.js";
import { startConnect, completeConnect } from "./platforms/connect.js";

// Real end-to-end Mastodon OAuth test, single process. Two-process CLI
// testing (separate start/finish scripts) breaks MastodonAdapter's
// per-instance app-registration cache — each process self-registers its
// own app, so a code issued to process A's client can't be exchanged by
// process B's client. That's a CLI-testing artifact only: the real
// deployed backend is one long-lived process holding one adapter
// instance, so this never happens there. This script keeps one adapter
// instance alive for the whole flow by polling a signal file for the
// OAuth code instead of exiting between steps.
const TEST_IMAGE_URL = "https://lazyrelay.com/favicon.png";
const CODE_FILE = "mastodon-oauth-code.txt";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const redirectUri = process.env.MASTODON_REDIRECT_URI || "http://localhost:9999/callback";

  if (existsSync(CODE_FILE)) unlinkSync(CODE_FILE);

  const email = `mastodon-sandbox-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user");
  const accountId = user.user.id;
  await supabase.from("accounts").insert({ id: accountId, email });
  console.log("Test account created:", accountId, email);

  const adapter = new MastodonAdapter(redirectUri);
  const registry = new Map([[adapter.platform, adapter]]);
  const { url: authorizeUrl } = await startConnect(accountId, adapter.platform, registry);
  const state = new URL(authorizeUrl).searchParams.get("state")!;

  console.log("\nOpen this URL, log in, and approve:\n");
  console.log(authorizeUrl);
  console.log(`\nWaiting for ${CODE_FILE} to contain the code (up to 5 minutes)...`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let code: string | null = null;
  while (Date.now() < deadline) {
    if (existsSync(CODE_FILE)) {
      code = readFileSync(CODE_FILE, "utf8").trim();
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!code) throw new Error("Timed out waiting for OAuth code");

  console.log("Got code, exchanging via completeConnect()...");
  const connectResult = await completeConnect(state, code, registry);
  if (connectResult.status !== "connected") {
    throw new Error(`Expected an immediate connect, got needs_selection (${connectResult.options.length} options)`);
  }
  const socialAccountId = connectResult.socialAccountId;
  console.log("social_accounts row created:", socialAccountId);

  const { data: account, error } = await supabase
    .from("social_accounts")
    .select("access_token_vault_id, platform_account_id, display_name")
    .eq("id", socialAccountId)
    .single();
  if (error || !account) throw error ?? new Error("social account not found");

  console.log("Connected Mastodon account:", account.platform_account_id, account.display_name);

  const { data: accessToken, error: readError } = await supabase.rpc("read_social_token", {
    p_vault_id: account.access_token_vault_id,
  });
  if (readError) throw readError;

  console.log("Retrieved real access token from Vault (length:", (accessToken as string).length, ")");
  console.log("\nPosting real test post with image:", TEST_IMAGE_URL);

  const postResult = await adapter.post({
    socialAccountId,
    accessToken: accessToken as string,
    content: "LazyRelay Mastodon adapter end-to-end test post",
    mediaUrl: TEST_IMAGE_URL,
    coverImageUrl: null,
  });
  console.log("post() result:", postResult);

  if (!postResult.success || !postResult.platformPostId) {
    console.log("ALL FAIL — post() did not succeed");
    process.exit(1);
  }

  console.log("\nCalling verifyPublished()...");
  const verifyResult = await adapter.verifyPublished(postResult.platformPostId, accessToken as string);
  console.log("verifyPublished() result:", verifyResult);

  console.log(verifyResult.verifiedLive ? "ALL PASS — post is verified live on Mastodon" : "PARTIAL — post() succeeded but verifyPublished() did not confirm live");
  process.exit(verifyResult.verifiedLive ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
