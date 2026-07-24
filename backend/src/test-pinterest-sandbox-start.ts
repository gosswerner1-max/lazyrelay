import "dotenv/config";
import { writeFileSync } from "fs";
import { supabase } from "./supabase.js";
import { PinterestAdapter } from "./platforms/pinterest.js";
import { startConnect } from "./platforms/connect.js";

// Real end-to-end Pinterest trial-access test, phase 1: create a throwaway
// test account and start the real OAuth connect flow against Pinterest's
// live API. Mirrors test-tiktok-sandbox-start.ts.
async function main() {
  const appId = process.env.PINTEREST_APP_ID;
  const appSecret = process.env.PINTEREST_APP_SECRET;
  const redirectUri = process.env.PINTEREST_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) {
    throw new Error("PINTEREST_APP_ID/APP_SECRET/REDIRECT_URI must be set in .env");
  }

  const email = `pinterest-sandbox-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user");
  const accountId = user.user.id;
  await supabase.from("accounts").insert({ id: accountId, email });

  const adapter = new PinterestAdapter(appId, appSecret, redirectUri);
  const authorizeUrl = await startConnect(accountId, adapter);

  writeFileSync(
    "pinterest-sandbox-test-state.json",
    JSON.stringify({ accountId, email }, null, 2),
  );

  console.log("Test account created:", accountId, email);
  console.log("\nOpen this URL, log in as the trial-access Pinterest test user, and approve:\n");
  console.log(authorizeUrl);
  console.log("\nAfter approving, Pinterest will redirect to the callback URL with ?code=...&state=...");
  console.log("Copy the `code` query param value and pass it to test-pinterest-sandbox-finish.ts");
}

main().catch((err) => {
  console.error("Start failed:", err);
  process.exit(1);
});
