import "dotenv/config";
import { TikTokAdapter } from "./platforms/tiktok.js";

// Smoke test for the parts of the real TikTok adapter that don't require an
// actual browser OAuth round-trip (getAuthorizeUrl is pure). exchangeCode/
// post/verifyPublished need a real authorization code from TikTok's own
// redirect, which requires a human logging in via the browser — see
// test-connect.ts for the adapter-agnostic connect-flow test, and the
// project-platform-app-registration memory for how to do a real end-to-end
// TikTok Sandbox test once a test-user account exists.

async function main() {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;
  if (!clientKey || !clientSecret || !redirectUri) {
    throw new Error("TIKTOK_CLIENT_KEY/SECRET/REDIRECT_URI must be set in .env for this test");
  }

  const adapter = new TikTokAdapter(clientKey, clientSecret, redirectUri);

  console.log(`[adapter.platform] -> ${adapter.platform}`);
  const pass1 = adapter.platform === "tiktok";
  console.log(`[platform is "tiktok"] -> ${pass1 ? "PASS" : "FAIL"}`);

  const url = await adapter.getAuthorizeUrl("test-state-123");
  console.log("Authorize URL:", url);
  const parsed = new URL(url);

  const pass2 = parsed.origin + parsed.pathname === "https://www.tiktok.com/v2/auth/authorize/";
  console.log(`[correct authorize endpoint] -> ${pass2 ? "PASS" : "FAIL"}`);

  const pass3 = parsed.searchParams.get("client_key") === clientKey;
  console.log(`[client_key present] -> ${pass3 ? "PASS" : "FAIL"}`);

  const pass4 = parsed.searchParams.get("scope") === "user.info.basic,video.publish";
  console.log(`[scope is user.info.basic,video.publish] -> ${pass4 ? "PASS" : "FAIL"}`);

  const pass5 = parsed.searchParams.get("response_type") === "code";
  console.log(`[response_type is code] -> ${pass5 ? "PASS" : "FAIL"}`);

  const pass6 = parsed.searchParams.get("redirect_uri") === redirectUri;
  console.log(`[redirect_uri matches env] -> ${pass6 ? "PASS" : "FAIL"}`);

  const pass7 = parsed.searchParams.get("state") === "test-state-123";
  console.log(`[state echoed back] -> ${pass7 ? "PASS" : "FAIL"}`);

  const allPass = [pass1, pass2, pass3, pass4, pass5, pass6, pass7].every(Boolean);
  console.log(allPass ? "ALL PASS" : "SOME FAILED");
  process.exit(allPass ? 0 : 1);
}

main();
