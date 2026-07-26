import "dotenv/config";
import { supabase } from "./supabase.js";
import { TumblrAdapter } from "./platforms/tumblr.js";
import { existsSync, unlinkSync, readFileSync } from "node:fs";

// Real end-to-end Tumblr OAuth 2.0 test, same signal-file-polling pattern
// as test-facebook-sandbox-e2e.ts.
const TEST_IMAGE_URL = "https://lazyrelay.com/favicon.png";
const CODE_FILE = "tumblr-oauth-code.txt";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const clientId = process.env.TUMBLR_CLIENT_ID;
  const clientSecret = process.env.TUMBLR_CLIENT_SECRET;
  const redirectUri = process.env.TUMBLR_REDIRECT_URI || "http://localhost:9999/callback";
  if (!clientId || !clientSecret) throw new Error("TUMBLR_CLIENT_ID / TUMBLR_CLIENT_SECRET not set");

  if (existsSync(CODE_FILE)) unlinkSync(CODE_FILE);

  const email = `tumblr-sandbox-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user");
  const accountId = user.user.id;
  await supabase.from("accounts").insert({ id: accountId, email });
  console.log("Test account created:", accountId, email);

  const adapter = new TumblrAdapter(clientId, clientSecret, redirectUri);
  const state = `test-${Date.now()}`;
  const authorizeUrl = await adapter.getAuthorizeUrl(state);
  console.log("\nOpen this URL in a browser, log in as the account that manages the target Tumblr blog, approve, then");
  console.log(`write the "code" query param from the redirect URL into ${CODE_FILE}:\n`);
  console.log(authorizeUrl);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!existsSync(CODE_FILE)) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for OAuth code");
    await sleep(POLL_INTERVAL_MS);
  }
  const code = readFileSync(CODE_FILE, "utf-8").trim();
  console.log("\nGot code, exchanging...");

  const exchangeResult = await adapter.exchangeCode(code);
  console.log("exchangeCode() result:", { ...exchangeResult, accessToken: "[redacted]", refreshToken: exchangeResult.refreshToken ? "[redacted]" : null });

  const { data: accessVaultId, error: accessVaultError } = await supabase.rpc("store_social_token", {
    p_token: exchangeResult.accessToken,
  });
  if (accessVaultError) throw accessVaultError;

  let refreshVaultId: string | null = null;
  if (exchangeResult.refreshToken) {
    const { data, error } = await supabase.rpc("store_social_token", { p_token: exchangeResult.refreshToken });
    if (error) throw error;
    refreshVaultId = data;
  }

  const { data: socialAccount, error: insertError } = await supabase
    .from("social_accounts")
    .insert({
      account_id: accountId,
      platform: "tumblr",
      platform_account_id: exchangeResult.platformAccountId,
      display_name: exchangeResult.displayName,
      access_token_vault_id: accessVaultId,
      refresh_token_vault_id: refreshVaultId,
      token_expires_at: exchangeResult.expiresAt,
    })
    .select("id")
    .single();
  if (insertError || !socialAccount) throw insertError;
  console.log("social_accounts row created:", socialAccount.id);

  console.log("\nPosting real test post with image:", TEST_IMAGE_URL);
  const postResult = await adapter.post({
    socialAccountId: socialAccount.id,
    accessToken: exchangeResult.accessToken,
    content: "LazyRelay Tumblr adapter end-to-end test post",
    mediaUrl: TEST_IMAGE_URL,
  });
  console.log("post() result:", postResult);

  if (!postResult.success || !postResult.platformPostId) {
    console.log("ALL FAIL — post() did not succeed");
    process.exit(1);
  }

  console.log("\nCalling verifyPublished()...");
  const verifyResult = await adapter.verifyPublished(postResult.platformPostId, exchangeResult.accessToken);
  console.log("verifyPublished() result:", verifyResult);

  console.log(verifyResult.verifiedLive ? "ALL PASS — post is verified live on Tumblr" : "PARTIAL — post() succeeded but verifyPublished() did not confirm live");
  process.exit(verifyResult.verifiedLive ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
