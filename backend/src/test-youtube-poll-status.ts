import "dotenv/config";
import { supabase } from "./supabase.js";
import { YouTubeAdapter } from "./platforms/youtube.js";

// One-off: poll verifyPublished() longer than the adapter's built-in budget,
// to check whether YouTube processing just needed more time than 15s.
async function main() {
  const socialAccountId = process.argv[2];
  const platformPostId = process.argv[3];

  const clientId = process.env.YOUTUBE_CLIENT_ID!;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET!;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI!;
  const adapter = new YouTubeAdapter(clientId, clientSecret, redirectUri);

  const { data: account } = await supabase
    .from("social_accounts")
    .select("access_token_vault_id")
    .eq("id", socialAccountId)
    .single();
  const { data: accessToken } = await supabase.rpc("read_social_token", {
    p_vault_id: account!.access_token_vault_id,
  });

  for (let i = 0; i < 10; i++) {
    const result = await adapter.verifyPublished(platformPostId, accessToken as string);
    console.log(`Attempt ${i + 1}:`, result);
    if (result.verifiedLive) {
      console.log("ALL PASS — video is verified live on YouTube");
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log("Still not live after extended polling.");
}
main();
