import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";

// Real, live verification for the remaining 2026-09-06 low-severity fixes
// that don't already have their own dedicated test: bio-page avatarUrl SSRF
// validation, and the length caps on scheduled-post optional fields.

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
  const email = `lowsev-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@lazyrelay.invalid`;
  const password = "LowSevTest123!";
  const { data: user, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !user.user) throw error ?? new Error("no user");
  await supabase.from("accounts").upsert({ id: user.user.id, email });
  const { data: signIn, error: signInError } = await authClient.auth.signInWithPassword({ email, password });
  if (signInError || !signIn.session) throw signInError ?? new Error("no session");
  return { accountId: user.user.id, jwt: signIn.session.access_token };
}

async function main() {
  const { accountId, jwt } = await makeAccount("a");
  try {
    // --- Bio-page avatarUrl SSRF validation ---
    const badAvatarRes = await fetch(`${API_URL}/bio-page`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "lowsev-test", title: "Test", bio: "Test bio", avatarUrl: "https://169.254.169.254/x" }),
    });
    report(
      "PUT /bio-page rejects an avatarUrl pointing at the cloud-metadata address",
      badAvatarRes.status === 400,
      `status ${badAvatarRes.status}`,
    );

    const goodAvatarRes = await fetch(`${API_URL}/bio-page`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "lowsev-test", title: "Test", bio: "Test bio", avatarUrl: null }),
    });
    report("PUT /bio-page with no avatarUrl still works normally (no regression)", goodAvatarRes.status === 200, `status ${goodAvatarRes.status}`);

    // --- scheduled-posts optional-field length caps ---
    const { data: vaultId } = await supabase.rpc("store_social_token", { p_token: `lowsev-token-${Date.now()}` });
    const { data: social } = await supabase
      .from("social_accounts")
      .insert({
        account_id: accountId,
        platform: "meta",
        platform_account_id: `lowsev-page-${Date.now()}`,
        display_name: "Low Sev Test Page",
        access_token_vault_id: vaultId,
      })
      .select("id")
      .single();

    const overLongFirstComment = "x".repeat(2201);
    const postRes = await fetch(`${API_URL}/scheduled-posts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        socialAccountId: social!.id,
        content: "test post",
        firstComment: overLongFirstComment,
        scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      }),
    });
    report(
      "POST /scheduled-posts rejects a firstComment over the new length cap",
      postRes.status === 400,
      `status ${postRes.status}`,
    );

    const okPostRes = await fetch(`${API_URL}/scheduled-posts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        socialAccountId: social!.id,
        content: "test post",
        firstComment: "a normal, real comment",
        scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      }),
    });
    report(
      "POST /scheduled-posts with a normal-length firstComment still works (no regression)",
      okPostRes.status === 201,
      `status ${okPostRes.status}`,
    );
  } finally {
    await supabase.auth.admin.deleteUser(accountId);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Low-severity fixes test crashed:", err);
  process.exit(1);
});
