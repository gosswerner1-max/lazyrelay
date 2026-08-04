import "dotenv/config";
import { supabase } from "./supabase.js";
import { BlueskyAdapter } from "./platforms/bluesky.js";

// Real end-to-end Bluesky app-password test, single phase (no OAuth
// redirect to split across two scripts, unlike TikTok/Pinterest/YouTube —
// see platforms/bluesky.ts for why). Creates a throwaway test account,
// exchanges the real handle+app-password for a real session via
// exchangeCode(), stores the token in Vault, posts a real test post, then
// independently verifies it went live.
const TEST_IMAGE_URL = "https://lazyrelay.com/favicon.png";

async function main() {
  const identifier = process.argv[2];
  const password = process.argv[3];
  if (!identifier || !password) {
    throw new Error("usage: test-bluesky-sandbox-e2e.ts <handle> <app-password>");
  }

  const email = `bluesky-sandbox-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user");
  const accountId = user.user.id;
  await supabase.from("accounts").insert({ id: accountId, email });
  console.log("Test account created:", accountId, email);

  const adapter = new BlueskyAdapter("https://lazyrelay.com/connect/bluesky");

  console.log("\nExchanging handle+app-password via exchangeCode()...");
  const exchangeResult = await adapter.exchangeCode(JSON.stringify({ identifier, password }));
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
      platform: "bluesky",
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
    content: "LazyRelay Bluesky adapter end-to-end test post",
    mediaUrl: TEST_IMAGE_URL,
    coverImageUrl: null,
  });
  console.log("post() result:", postResult);

  if (!postResult.success || !postResult.platformPostId) {
    console.log("ALL FAIL — post() did not succeed");
    process.exit(1);
  }

  console.log("\nCalling verifyPublished()...");
  const verifyResult = await adapter.verifyPublished(postResult.platformPostId, exchangeResult.accessToken);
  console.log("verifyPublished() result:", verifyResult);

  console.log(verifyResult.verifiedLive ? "ALL PASS — post is verified live on Bluesky" : "PARTIAL — post() succeeded but verifyPublished() did not confirm live");
  process.exit(verifyResult.verifiedLive ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
