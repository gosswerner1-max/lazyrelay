import "dotenv/config";
import { supabase } from "./supabase.js";
import { createClient } from "@supabase/supabase-js";

// Real security tests against the LOCAL backend — authorized self-testing
// of our own infrastructure, no third-party targets involved. Covers auth
// bypass, IDOR (cross-account data access), input validation, upload
// spoofing, and webhook forgery. Every check either asserts a rejection
// (401/403/404/400) or asserts real cross-account isolation by creating
// two independent accounts and trying to cross the boundary.

const API_URL = "http://localhost:3000/api";
let failures = 0;

function report(label: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "PASS" : "FAIL"} — ${label}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures++;
}

const authClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function makeAccount(prefix: string): Promise<{ accountId: string; jwt: string }> {
  const email = `sectest-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@lazyrelay.invalid`;
  const password = "SecTest123!";
  const { data: user, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !user.user) throw error ?? new Error("no user");
  await supabase.from("accounts").upsert({ id: user.user.id, email });
  const { data: signIn, error: signInError } = await authClient.auth.signInWithPassword({ email, password });
  if (signInError || !signIn.session) throw signInError ?? new Error("no session");
  return { accountId: user.user.id, jwt: signIn.session.access_token };
}

async function seedSocialAccount(accountId: string): Promise<string> {
  const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
    p_token: `sectest-token-${Date.now()}-${Math.random()}`,
  });
  if (vaultError) throw vaultError;
  const { data, error } = await supabase
    .from("social_accounts")
    .insert({
      account_id: accountId,
      platform: "meta",
      platform_account_id: `sectest-page-${Date.now()}-${Math.random()}`,
      display_name: "Sec Test Page",
      access_token_vault_id: vaultId,
    })
    .select("id")
    .single();
  if (error || !data) throw error;
  return data.id;
}

async function seedScheduledPost(accountId: string, socialAccountId: string): Promise<string> {
  const { data, error } = await supabase
    .from("scheduled_posts")
    .insert({
      account_id: accountId,
      social_account_id: socialAccountId,
      content: "Security test post — should not be readable/deletable by another account",
      scheduled_for: new Date(Date.now() + 3600_000).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw error;
  return data.id;
}

async function cleanup(accountIds: string[]) {
  for (const id of accountIds) {
    try {
      await supabase.from("accounts").delete().eq("id", id);
    } catch {
      /* best effort */
    }
    try {
      await supabase.auth.admin.deleteUser(id);
    } catch {
      /* best effort */
    }
  }
}

// --- 1. Auth bypass: no token, garbage token, expired-looking token ---
async function testAuthBypass() {
  const noAuth = await fetch(`${API_URL}/social-accounts`);
  report("GET /social-accounts with no Authorization header is rejected", noAuth.status === 401, `status ${noAuth.status}`);

  const garbageAuth = await fetch(`${API_URL}/social-accounts`, {
    headers: { Authorization: "Bearer not-a-real-token-at-all" },
  });
  report("GET /social-accounts with a garbage bearer token is rejected", garbageAuth.status === 401, `status ${garbageAuth.status}`);

  // A JWT-shaped-but-forged token (valid structure, invalid signature) —
  // makes sure the check is real signature verification, not just "does
  // this look like a JWT".
  const forgedJwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    Buffer.from(JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000", role: "authenticated" })).toString("base64url") +
    ".forged-signature-not-real";
  const forgedAuth = await fetch(`${API_URL}/social-accounts`, { headers: { Authorization: `Bearer ${forgedJwt}` } });
  report("GET /social-accounts with a structurally-valid but forged JWT is rejected", forgedAuth.status === 401, `status ${forgedAuth.status}`);
}

// --- 2. IDOR: account A tries to read/modify account B's data ---
async function testIDOR(accountA: { accountId: string; jwt: string }, accountB: { accountId: string; jwt: string }) {
  const socialAccountB = await seedSocialAccount(accountB.accountId);
  const postB = await seedScheduledPost(accountB.accountId, socialAccountB);

  // A tries to schedule a post against B's social_accounts row.
  const crossSchedule = await fetch(`${API_URL}/scheduled-posts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accountA.jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      socialAccountId: socialAccountB,
      content: "IDOR attempt — should be rejected",
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
    }),
  });
  report(
    "Account A cannot schedule a post against Account B's social_accounts row",
    crossSchedule.status === 403,
    `status ${crossSchedule.status}`,
  );

  // A tries to delete B's scheduled post.
  const crossDelete = await fetch(`${API_URL}/scheduled-posts/${postB}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accountA.jwt}` },
  });
  report("Account A cannot delete Account B's scheduled post", crossDelete.status === 404, `status ${crossDelete.status}`);
  const { data: stillThere } = await supabase.from("scheduled_posts").select("id").eq("id", postB).maybeSingle();
  report("Account B's post still exists after A's delete attempt", !!stillThere);

  // A's own /scheduled-posts list must not leak B's post.
  const listA = await fetch(`${API_URL}/scheduled-posts`, { headers: { Authorization: `Bearer ${accountA.jwt}` } }).then((r) => r.json());
  const leaked = Array.isArray(listA) && listA.some((p: { id: string }) => p.id === postB);
  report("Account A's /scheduled-posts list does not include Account B's post", !leaked);

  // A's /social-accounts list must not leak B's connected account.
  const accountsA = await fetch(`${API_URL}/social-accounts`, { headers: { Authorization: `Bearer ${accountA.jwt}` } }).then((r) => r.json());
  const accountLeaked = Array.isArray(accountsA) && accountsA.some((a: { id: string }) => a.id === socialAccountB);
  report("Account A's /social-accounts list does not include Account B's connected account", !accountLeaked);
}

// --- 3. Upload validation: spoofed content-type / disguised extension ---
async function testUploadSpoofing(jwt: string) {
  // A real EICAR-style plain text file renamed to look like a PNG, with
  // a spoofed multipart Content-Type header — tests that detection is by
  // real magic bytes, not the client-supplied mimetype/filename.
  const fakePng = Buffer.from("this is not actually a png, just text pretending to be one");
  const form = new FormData();
  form.append("file", new Blob([fakePng], { type: "image/png" }), "totally-a-photo.png");

  const res = await fetch(`${API_URL}/media/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  report("Spoofed image/png upload (real bytes are plain text) is rejected", res.status === 400, `status ${res.status}`);

  // A real HTML file with a spoofed .png extension/mimetype — the classic
  // stored-XSS-via-upload vector if the server ever serves it back as HTML.
  const fakeHtml = Buffer.from("<script>alert(document.cookie)</script>");
  const form2 = new FormData();
  form2.append("file", new Blob([fakeHtml], { type: "image/png" }), "photo.png");
  const res2 = await fetch(`${API_URL}/media/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form2,
  });
  report("HTML/script content disguised as image/png upload is rejected", res2.status === 400, `status ${res2.status}`);
}

// --- 4. Input validation: oversized/malformed scheduled-post payloads ---
async function testInputValidation(jwt: string, socialAccountId: string) {
  const oversized = await fetch(`${API_URL}/scheduled-posts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      socialAccountId,
      content: "x".repeat(50_000),
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
    }),
  });
  report("Oversized post content (50k chars) is rejected, not silently truncated", oversized.status === 400, `status ${oversized.status}`);

  const pastDate = await fetch(`${API_URL}/scheduled-posts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ socialAccountId, content: "test", scheduledFor: "2020-01-01T00:00:00Z" }),
  });
  report("Scheduling a post far in the past is rejected", pastDate.status === 400, `status ${pastDate.status}`);

  const badPlatform = await fetch(`${API_URL}/social-accounts/connect?platform=${encodeURIComponent("'; DROP TABLE accounts; --")}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  report("SQL-injection-shaped platform query param is rejected as an invalid platform, not executed", badPlatform.status === 400, `status ${badPlatform.status}`);

  const { error: dbStillHealthy } = await supabase.from("accounts").select("id").limit(1);
  report("accounts table still queryable after injection-shaped input (no injection occurred)", !dbStillHealthy);
}

// --- 5. Webhook forgery ---
async function testWebhookForgery() {
  const forged = await fetch(`${API_URL}/webhooks/mor`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "paddle-signature": "ts=1;h1=totally-forged" },
    body: JSON.stringify({
      event_type: "subscription.activated",
      data: { custom_data: { account_id: "00000000-0000-0000-0000-000000000000" }, status: "active" },
    }),
  });
  report("Forged Paddle webhook signature is rejected", forged.status === 401, `status ${forged.status}`);

  const noSig = await fetch(`${API_URL}/webhooks/mor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: "subscription.activated" }),
  });
  report("Webhook with no signature header at all is rejected", noSig.status === 401, `status ${noSig.status}`);
}

// --- 6. CORS ---
async function testCORS() {
  const res = await fetch(`${API_URL}/platforms`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil-attacker.example",
      "Access-Control-Request-Method": "GET",
    },
  });
  const allowOrigin = res.headers.get("access-control-allow-origin");
  report(
    "CORS does not reflect an arbitrary attacker Origin (should be the configured frontend origin or absent)",
    allowOrigin !== "https://evil-attacker.example" && allowOrigin !== "*",
    `Access-Control-Allow-Origin: ${allowOrigin}`,
  );
}

async function main() {
  console.log("=== LazyRelay security test ===\n");
  const cleanupIds: string[] = [];

  try {
    await testAuthBypass();
  } catch (err) {
    report("auth bypass tests threw", false, err instanceof Error ? err.message : String(err));
  }

  try {
    const accountA = await makeAccount("a");
    const accountB = await makeAccount("b");
    cleanupIds.push(accountA.accountId, accountB.accountId);
    await testIDOR(accountA, accountB);

    const socialAccountA = await seedSocialAccount(accountA.accountId);
    await testUploadSpoofing(accountA.jwt);
    await testInputValidation(accountA.jwt, socialAccountA);
  } catch (err) {
    report("account-scoped tests threw", false, err instanceof Error ? err.message : String(err));
  }

  try {
    await testWebhookForgery();
  } catch (err) {
    report("webhook forgery tests threw", false, err instanceof Error ? err.message : String(err));
  }

  try {
    await testCORS();
  } catch (err) {
    report("CORS test threw", false, err instanceof Error ? err.message : String(err));
  }

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} ===`);
  await cleanup(cleanupIds);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Security test crashed:", err);
  process.exit(1);
});
