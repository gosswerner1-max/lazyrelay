import "dotenv/config";
import { supabase } from "./supabase.js";
import { TikTokAdapter } from "./platforms/tiktok.js";
import { getAccessToken } from "./scheduler.js";

// One-off verification for the new checkDirectPostEligible() pre-flight
// check: confirms the real creator_info/query call works against a live,
// already-connected sandbox account, and that the existing post()/
// verifyPublished() pipeline still succeeds now that the check is wired in.
const TEST_VIDEO_URL = "https://lazyrelay.com/lazyrelay-test-video.mp4";

async function main() {
  const socialAccountId = process.argv[2];
  if (!socialAccountId) throw new Error("usage: test-tiktok-eligibility.ts <socialAccountId>");

  const { data: account, error } = await supabase
    .from("social_accounts")
    .select("platform_account_id, display_name")
    .eq("id", socialAccountId)
    .single();
  if (error || !account) throw error ?? new Error("social account not found");

  const clientKeyEarly = process.env.TIKTOK_CLIENT_KEY!;
  const clientSecretEarly = process.env.TIKTOK_CLIENT_SECRET!;
  const redirectUriEarly = process.env.TIKTOK_REDIRECT_URI!;
  const earlyAdapter = new TikTokAdapter(clientKeyEarly, clientSecretEarly, redirectUriEarly);
  // Uses the real refresh path (same one the scheduler uses) instead of a
  // possibly-stale raw token — TikTok access tokens die within ~24h.
  const accessToken = await getAccessToken(socialAccountId, earlyAdapter);

  console.log("Connected TikTok account:", account.platform_account_id, account.display_name);

  console.log("\n--- Raw creator_info/query call ---");
  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
  });
  console.log("HTTP status:", res.status);
  console.log("Body:", JSON.stringify(await res.clone().json(), null, 2));

  console.log("\n--- Full post() call (now includes the eligibility pre-check) ---");
  const adapter = earlyAdapter;

  const postResult = await adapter.post({
    socialAccountId,
    accessToken: accessToken as string,
    content: "LazyRelay eligibility-check regression test",
    mediaUrl: TEST_VIDEO_URL,
    coverImageUrl: null,
  });
  console.log("post() result:", postResult);

  if (!postResult.success || !postResult.platformPostId) {
    console.log("FAIL — post() did not succeed with the eligibility check wired in");
    process.exit(1);
  }

  const verifyResult = await adapter.verifyPublished(postResult.platformPostId, accessToken as string);
  console.log("verifyPublished() result:", verifyResult);
  console.log(verifyResult.verifiedLive ? "ALL PASS" : "PARTIAL — not yet confirmed live");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
