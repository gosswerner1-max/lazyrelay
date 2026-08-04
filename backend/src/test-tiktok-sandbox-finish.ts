import "dotenv/config";
import { supabase } from "./supabase.js";
import { TikTokAdapter } from "./platforms/tiktok.js";

// Real end-to-end TikTok Sandbox test, phase 2: fetch the real access token
// for the just-connected social_accounts row, post a real public test video
// via pull_by_url, and poll verifyPublished() to confirm it actually went
// live on TikTok — not just that post() returned success.
const TEST_VIDEO_URL = "https://lazyrelay.com/lazyrelay-test-video.mp4";

async function main() {
  const socialAccountId = process.argv[2];
  if (!socialAccountId) throw new Error("usage: test-tiktok-sandbox-finish.ts <socialAccountId>");

  const clientKey = process.env.TIKTOK_CLIENT_KEY!;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET!;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI!;
  const adapter = new TikTokAdapter(clientKey, clientSecret, redirectUri);

  const { data: account, error } = await supabase
    .from("social_accounts")
    .select("access_token_vault_id, platform_account_id, display_name")
    .eq("id", socialAccountId)
    .single();
  if (error || !account) throw error ?? new Error("social account not found");

  console.log("Connected TikTok account:", account.platform_account_id, account.display_name);

  const { data: accessToken, error: readError } = await supabase.rpc("read_social_token", {
    p_vault_id: account.access_token_vault_id,
  });
  if (readError) throw readError;

  console.log("Retrieved real access token from Vault (length:", (accessToken as string).length, ")");
  console.log("\nPosting real video via pull_by_url:", TEST_VIDEO_URL);

  const postResult = await adapter.post({
    socialAccountId,
    accessToken: accessToken as string,
    content: "LazyRelay Sandbox end-to-end test post",
    mediaUrl: TEST_VIDEO_URL,
    coverImageUrl: null,
  });
  console.log("post() result:", postResult);

  if (!postResult.success || !postResult.platformPostId) {
    console.log("ALL FAIL — post() did not succeed");
    process.exit(1);
  }

  console.log("\nPolling verifyPublished()...");
  const verifyResult = await adapter.verifyPublished(postResult.platformPostId, accessToken as string);
  console.log("verifyPublished() result:", verifyResult);

  console.log(verifyResult.verifiedLive ? "ALL PASS — post is verified live on TikTok" : "PARTIAL — post() succeeded but verifyPublished() did not confirm live yet");
  process.exit(0);
}

main().catch((err) => {
  console.error("Finish failed:", err);
  process.exit(1);
});
