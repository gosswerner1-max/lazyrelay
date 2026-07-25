import "dotenv/config";
import { supabase } from "./supabase.js";
import { TelegramAdapter } from "./platforms/telegram.js";

// Real end-to-end Telegram test, single phase (no OAuth — the bot token
// authenticates every call, see platforms/telegram.ts). Creates a
// throwaway test account, "exchanges" the real @channelUsername via
// exchangeCode() (which really just verifies the bot is admin with post
// rights), posts a real test post with an image, then independently
// verifies it via TELEGRAM_LOG_CHAT_ID's copyMessage existence-probe.
const TEST_IMAGE_URL = "https://lazyrelay.com/favicon.png";

async function main() {
  const channelUsername = process.argv[2];
  if (!channelUsername) {
    throw new Error("usage: test-telegram-sandbox-e2e.ts <@channelUsername>");
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const logChatId = process.env.TELEGRAM_LOG_CHAT_ID;
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN not set");

  const email = `telegram-sandbox-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user");
  const accountId = user.user.id;
  await supabase.from("accounts").insert({ id: accountId, email });
  console.log("Test account created:", accountId, email);

  const adapter = new TelegramAdapter(botToken, "https://lazyrelay.com/connect/telegram", logChatId);

  console.log("\nExchanging channel username via exchangeCode()...");
  const exchangeResult = await adapter.exchangeCode(JSON.stringify({ channelUsername }));
  console.log("exchangeCode() result:", exchangeResult);

  const { data: accessVaultId, error: accessVaultError } = await supabase.rpc("store_social_token", {
    p_token: exchangeResult.accessToken,
  });
  if (accessVaultError) throw accessVaultError;

  const { data: socialAccount, error: insertError } = await supabase
    .from("social_accounts")
    .insert({
      account_id: accountId,
      platform: "telegram",
      platform_account_id: exchangeResult.platformAccountId,
      display_name: exchangeResult.displayName,
      access_token_vault_id: accessVaultId,
      refresh_token_vault_id: null,
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
    content: "LazyRelay Telegram adapter end-to-end test post",
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

  console.log(verifyResult.verifiedLive ? "ALL PASS — post is verified live on Telegram" : "PARTIAL — post() succeeded but verifyPublished() did not confirm live");
  process.exit(verifyResult.verifiedLive ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
