import "dotenv/config";
import { supabase } from "./supabase.js";
import { createClient } from "@supabase/supabase-js";

// One-off manual smoke test — proves the Free tier's 10-posts-per-account
// monthly limit is actually enforced through the real deployed HTTP API,
// not just in the query logic. Self-cleaning: deletes the test user after.
const API_URL = "https://lazyrelaylazyrelay-backend.onrender.com/api";
const SUPABASE_URL = process.env.SUPABASE_URL!;
// Public anon key (safe to embed — same value as frontend/.env.production's
// VITE_SUPABASE_ANON_KEY), needed here only to mint a real user session via
// signInWithPassword rather than the service-role key this script otherwise uses.
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFibWVqbm15cW9nb3Rkenp6eXZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NjEzOTEsImV4cCI6MjEwMDEzNzM5MX0.T4eZr5JMhmb78UXQ-WlcZtNYB59fGw9ob05B-6TI7AI";

async function main() {
  const email = `free-tier-test-${Date.now()}@lazyrelay.invalid`;
  const password = "test-password-not-real-123";

  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  console.log(`Created test user ${email} (${accountId})`);

  try {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: session, error: signInError } = await anon.auth.signInWithPassword({ email, password });
    if (signInError || !session.session) throw signInError ?? new Error("no session returned");
    const accessToken = session.session.access_token;

    const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
      p_token: "test-access-token-value",
    });
    if (vaultError) throw vaultError;

    const { data: socialAccount, error: socialError } = await supabase
      .from("social_accounts")
      .insert({
        account_id: accountId,
        platform: "meta",
        platform_account_id: `free-tier-test-page-${Date.now()}`,
        display_name: "Free Tier Test Page",
        access_token_vault_id: vaultId,
      })
      .select()
      .single();
    if (socialError || !socialAccount) throw socialError;
    console.log(`Created social account ${socialAccount.id}`);

    const scheduledFor = new Date(Date.now() + 3600 * 1000).toISOString(); // 1h from now — scheduler won't touch these during the test
    const results: { attempt: number; status: number; body: unknown }[] = [];

    for (let i = 1; i <= 11; i++) {
      const res = await fetch(`${API_URL}/scheduled-posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          socialAccountId: socialAccount.id,
          content: `Free tier limit test post #${i}`,
          scheduledFor,
        }),
      });
      const body = await res.json();
      results.push({ attempt: i, status: res.status, body });
      console.log(`Post #${i}: HTTP ${res.status}`, res.status === 403 ? body : "");
    }

    const first10 = results.slice(0, 10);
    const eleventh = results[10];
    const first10AllCreated = first10.every((r) => r.status === 201);
    const eleventhRejected = eleventh.status === 403;

    console.log("\n--- RESULT ---");
    console.log("First 10 posts all created (201):", first10AllCreated);
    console.log("11th post rejected (403):", eleventhRejected, eleventh.body);
    console.log(first10AllCreated && eleventhRejected ? "PASS" : "FAIL");
  } finally {
    await supabase.auth.admin.deleteUser(accountId);
    console.log(`Cleaned up test user ${accountId}`);
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
