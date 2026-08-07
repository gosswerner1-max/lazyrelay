import "dotenv/config";
import { supabase } from "./supabase.js";
import { FacebookAdapter } from "./platforms/facebook.js";
import { InstagramAdapter } from "./platforms/instagram.js";

// One-off live test for postComment() (Task #28) — reuses the already-
// connected LazyRelay Facebook Page / Instagram account and an already-
// verified-live post from each, rather than creating new test posts.
// Delete this file once the live test is confirmed passing.
const FACEBOOK_SOCIAL_ACCOUNT_ID = "43458426-cb53-4876-aeb0-44a15be82573";
const FACEBOOK_POST_ID = "1224498757418764_122097071163415007";
const INSTAGRAM_SOCIAL_ACCOUNT_ID = "4f5e16a6-8cd3-449b-a797-c47ce2c84822";
const INSTAGRAM_POST_ID = "18065167355735567";

async function getToken(socialAccountId: string): Promise<string> {
  const { data: account, error } = await supabase
    .from("social_accounts")
    .select("access_token_vault_id")
    .eq("id", socialAccountId)
    .single();
  if (error || !account) throw error ?? new Error("social account not found");
  const { data: token, error: readError } = await supabase.rpc("read_social_token", {
    p_vault_id: account.access_token_vault_id,
  });
  if (readError) throw readError;
  return token as string;
}

async function main() {
  const clientId = process.env.META_APP_ID;
  const clientSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI || "http://localhost:9999/callback";
  if (!clientId || !clientSecret) throw new Error("META_APP_ID / META_APP_SECRET not set");

  const facebookAdapter = new FacebookAdapter(clientId, clientSecret, redirectUri);
  const instagramAdapter = new InstagramAdapter(clientId, clientSecret, redirectUri);

  const facebookToken = await getToken(FACEBOOK_SOCIAL_ACCOUNT_ID);
  console.log("\nPosting first-comment test on Facebook post", FACEBOOK_POST_ID);
  const fbResult = await facebookAdapter.postComment(FACEBOOK_POST_ID, "LazyRelay first-comment adapter test — safe to ignore/delete.", facebookToken);
  console.log("Facebook postComment() result:", fbResult);

  const instagramToken = await getToken(INSTAGRAM_SOCIAL_ACCOUNT_ID);
  console.log("\nPosting first-comment test on Instagram post", INSTAGRAM_POST_ID);
  const igResult = await instagramAdapter.postComment(INSTAGRAM_POST_ID, "LazyRelay first-comment adapter test — safe to ignore/delete.", instagramToken);
  console.log("Instagram postComment() result:", igResult);

  const allPass = fbResult.success && igResult.success;
  console.log(allPass ? "\nALL PASS" : "\nSOME FAILED — see results above");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
