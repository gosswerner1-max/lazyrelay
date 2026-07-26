import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";
import { StubAdapter } from "./platforms/stub.js";
import { StubMorAdapter } from "./billing/stub.js";
import { buildApp } from "./http/app.js";
import { runSchedulerCycle } from "./scheduler.js";

// A real bug was found and fixed here during testing: signInWithPassword()
// mutates the CALLING client's session state (that's its purpose). Calling
// it on the shared service-role `supabase` client silently switched all of
// its later requests to run as the signed-in test user instead of
// service_role, causing a real permission-denied failure. The fix is this
// separate client, used only to mint a test JWT — never call sign-in
// methods on the shared service-role client. (requireAuth in auth.ts is
// NOT affected: auth.getUser(explicitToken) is stateless when a token is
// passed explicitly, unlike signInWithPassword.)
const authClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const PORT = 3099;

async function main() {
  const stubAdapter = new StubAdapter();
  const registry = new Map([[stubAdapter.platform, stubAdapter]]);
  const app = buildApp(new StubMorAdapter(), registry);
  const server = app.listen(PORT);

  // Health check, no auth
  const health = await fetch(`http://localhost:${PORT}/health`).then((r) => r.json());
  console.log("Health:", health);

  // Unauthenticated request should be rejected
  const unauth = await fetch(`http://localhost:${PORT}/api/scheduled-posts`);
  console.log(`Unauthenticated GET status: ${unauth.status} -> ${unauth.status === 401 ? "PASS" : "FAIL"}`);

  // Real user + real JWT via Supabase Auth password grant
  const email = `http-test-${Date.now()}@lazyrelay.invalid`;
  const password = "test-password-123!";
  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user");
  await supabase.from("accounts").insert({ id: user.user.id, email });

  const { data: signIn, error: signInError } = await authClient.auth.signInWithPassword({ email, password });
  if (signInError || !signIn.session) throw signInError ?? new Error("no session");
  const jwt = signIn.session.access_token;

  // Seed a social account directly (not via API — that endpoint doesn't
  // exist yet, this is just test setup) so there's something to schedule against.
  const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", { p_token: "http-test-token" });
  if (vaultError) throw vaultError;
  const { data: socialAccount, error: socialError } = await supabase
    .from("social_accounts")
    .insert({
      account_id: user.user.id,
      platform: "meta",
      platform_account_id: "http-test-page",
      access_token_vault_id: vaultId,
    })
    .select()
    .single();
  if (socialError) throw socialError;

  // Authenticated create
  const createRes = await fetch(`http://localhost:${PORT}/api/scheduled-posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      socialAccountId: socialAccount!.id,
      content: "HTTP API test post",
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
    }),
  });
  const created = await createRes.json();
  console.log(`Create status: ${createRes.status} -> ${createRes.status === 201 ? "PASS" : "FAIL"}`, created);

  // Authenticated list
  const listRes = await fetch(`http://localhost:${PORT}/api/scheduled-posts`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const list = await listRes.json();
  console.log(`List status: ${listRes.status}, count: ${list.length} -> ${list.length === 1 ? "PASS" : "FAIL"}`);

  // Run the actual scheduler against it, then check the post shows as posted
  await runSchedulerCycle(registry);
  const listAfter = await fetch(`http://localhost:${PORT}/api/scheduled-posts`, {
    headers: { Authorization: `Bearer ${jwt}` },
  }).then((r) => r.json());
  console.log(
    `After scheduler run, status: ${listAfter[0]?.status} -> ${listAfter[0]?.status === "posted" ? "PASS" : "FAIL"}`,
  );

  // Cancel subscription — first without a subscription (should fail cleanly)
  const cancelNoSubRes = await fetch(`http://localhost:${PORT}/api/subscription/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  console.log(`Cancel with no subscription status: ${cancelNoSubRes.status} -> ${cancelNoSubRes.status === 502 ? "PASS" : "FAIL"}`);

  // Cleanup
  await supabase.auth.admin.deleteUser(user.user.id);
  server.close();
}

main().catch((err) => {
  console.error("HTTP test failed:", err);
  process.exit(1);
});
