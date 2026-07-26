import "dotenv/config";
import { writeFileSync } from "fs";
import { supabase } from "./supabase.js";
import { YouTubeAdapter } from "./platforms/youtube.js";
import { startConnect } from "./platforms/connect.js";

// Real end-to-end YouTube test, phase 1: create a throwaway test account and
// start the real OAuth connect flow against Google's live API. Mirrors
// test-tiktok-sandbox-start.ts / test-pinterest-sandbox-start.ts.
async function main() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("YOUTUBE_CLIENT_ID/SECRET/REDIRECT_URI must be set in .env");
  }

  const email = `youtube-sandbox-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user");
  const accountId = user.user.id;
  await supabase.from("accounts").insert({ id: accountId, email });

  const adapter = new YouTubeAdapter(clientId, clientSecret, redirectUri);
  const authorizeUrl = await startConnect(accountId, adapter.platform, new Map([[adapter.platform, adapter]]));

  writeFileSync(
    "youtube-sandbox-test-state.json",
    JSON.stringify({ accountId, email }, null, 2),
  );

  console.log("Test account created:", accountId, email);
  console.log("\nOpen this URL, log in as the Google account that owns the target YouTube channel, and approve:\n");
  console.log(authorizeUrl);
  console.log("\nAfter approving, Google will redirect to the callback URL with ?code=...&state=...");
  console.log("Copy the `code` query param value and pass it to test-youtube-sandbox-finish.ts");
}

main().catch((err) => {
  console.error("Start failed:", err);
  process.exit(1);
});
