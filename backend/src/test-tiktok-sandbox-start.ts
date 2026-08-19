import "dotenv/config";
import { writeFileSync } from "fs";
import { supabase } from "./supabase.js";
import { TikTokAdapter } from "./platforms/tiktok.js";
import { startConnect } from "./platforms/connect.js";

// Real end-to-end TikTok Sandbox test, phase 1: create a throwaway test account
// and start the real OAuth connect flow against TikTok's live API.
async function main() {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;
  if (!clientKey || !clientSecret || !redirectUri) {
    throw new Error("TIKTOK_CLIENT_KEY/SECRET/REDIRECT_URI must be set in .env");
  }

  const email = `tiktok-sandbox-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user");
  const accountId = user.user.id;
  await supabase.from("accounts").insert({ id: accountId, email });

  const adapter = new TikTokAdapter(clientKey, clientSecret, redirectUri);
  const { url: authorizeUrl } = await startConnect(accountId, adapter.platform, new Map([[adapter.platform, adapter]]));

  writeFileSync(
    "tiktok-sandbox-test-state.json",
    JSON.stringify({ accountId, email }, null, 2),
  );

  console.log("Test account created:", accountId, email);
  console.log("\nOpen this URL, log in as the @lazyrelay2 Sandbox target user, and approve:\n");
  console.log(authorizeUrl);
  console.log("\nAfter approving, TikTok will redirect to the callback URL with ?code=...&state=...");
  console.log("Copy the `code` query param value and pass it to test-tiktok-sandbox-finish.ts");
}

main().catch((err) => {
  console.error("Start failed:", err);
  process.exit(1);
});
