import "dotenv/config";
import { supabase } from "./supabase.js";
import { PinterestAdapter } from "./platforms/pinterest.js";

// Real end-to-end test of the new video Pin flow (register -> upload -> poll
// -> create Pin with media_source video_id + cover_image_url) against an
// already-connected Pinterest sandbox account.
const TEST_VIDEO_URL = "https://filesamples.com/samples/video/mp4/sample_640x360.mp4";
const TEST_COVER_IMAGE_URL = "https://lazyrelay.com/favicon.png";

async function main() {
  const socialAccountId = process.argv[2];
  if (!socialAccountId) throw new Error("usage: test-pinterest-video-pin.ts <socialAccountId>");

  const appId = process.env.PINTEREST_APP_ID!;
  const appSecret = process.env.PINTEREST_APP_SECRET!;
  const redirectUri = process.env.PINTEREST_REDIRECT_URI!;
  const adapter = new PinterestAdapter(appId, appSecret, redirectUri);

  const { data: account, error } = await supabase
    .from("social_accounts")
    .select("access_token_vault_id, platform_account_id, display_name")
    .eq("id", socialAccountId)
    .single();
  if (error || !account) throw error ?? new Error("social account not found");

  console.log("Connected Pinterest account:", account.platform_account_id, account.display_name);

  const { data: accessToken, error: readError } = await supabase.rpc("read_social_token", {
    p_vault_id: account.access_token_vault_id,
  });
  if (readError) throw readError;

  console.log("Retrieved real access token from Vault (length:", (accessToken as string).length, ")");
  console.log("\nPosting real video Pin:", TEST_VIDEO_URL, "with cover:", TEST_COVER_IMAGE_URL);

  const postResult = await adapter.post({
    socialAccountId,
    accessToken: accessToken as string,
    content: "LazyRelay Pinterest video Pin end-to-end test post",
    mediaUrl: TEST_VIDEO_URL,
    coverImageUrl: TEST_COVER_IMAGE_URL,
  });
  console.log("post() result:", postResult);

  if (!postResult.success || !postResult.platformPostId) {
    console.log("ALL FAIL — post() did not succeed");
    process.exit(1);
  }

  console.log("\nCalling verifyPublished()...");
  const verifyResult = await adapter.verifyPublished(postResult.platformPostId, accessToken as string);
  console.log("verifyPublished() result:", verifyResult);

  console.log(verifyResult.verifiedLive ? "ALL PASS — video Pin is verified live on Pinterest" : "PARTIAL — post() succeeded but verifyPublished() did not confirm live");
  process.exit(0);
}

main().catch((err) => {
  console.error("Video pin test failed:", err);
  process.exit(1);
});
