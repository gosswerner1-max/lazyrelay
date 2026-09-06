import "dotenv/config";
import { supabase } from "./supabase.js";

// One-off helper: creates a throwaway test account and generates a
// passwordless magic sign-in link for it via the admin API, so the
// Settings/storage-gauge UI can be visually checked in a real browser
// session without ever touching a password.
//
// Self-cleans its OWN past runs on every invocation (added 2026-09-06,
// after a 2026-09-04 fixture from this exact script sat live in production
// for 2 days -- the sibling security-test.ts cleans up at the end of its
// own run, but this script's account has to survive past the point the
// script exits, since a human still needs to click the link afterward, so
// end-of-run cleanup would delete it before it's ever used). Instead, any
// PRIOR `ui-check-*@lazyrelay.invalid` row older than an hour -- long
// enough for a real manual UI check, never long enough to catch a fixture
// still in use -- is deleted before a new one is created. The exact
// `ui-check-` prefix + `@lazyrelay.invalid` suffix match means this can
// only ever touch fixtures this script itself created, never a real
// account.
const STALE_MS = 60 * 60 * 1000;

async function cleanupStaleFixtures() {
  const { data: rows, error } = await supabase
    .from("accounts")
    .select("id, email, created_at")
    .like("email", "ui-check-%@lazyrelay.invalid");
  if (error) {
    console.error("[generate-test-login-link cleanup] listing stale fixtures failed:", error.message);
    return;
  }
  const stale = (rows ?? []).filter((row) => Date.now() - new Date(row.created_at).getTime() > STALE_MS);
  for (const row of stale) {
    const { error: deleteRowError } = await supabase.from("accounts").delete().eq("id", row.id);
    if (deleteRowError) console.error(`[generate-test-login-link cleanup] delete accounts row ${row.id} failed:`, deleteRowError.message);
    const { error: deleteUserError } = await supabase.auth.admin.deleteUser(row.id);
    if (deleteUserError) console.error(`[generate-test-login-link cleanup] delete auth user ${row.id} failed:`, deleteUserError.message);
    console.log(`Cleaned up stale fixture: ${row.email} (${row.id})`);
  }
}

async function main() {
  await cleanupStaleFixtures();

  const email = `ui-check-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (error || !user.user) throw error ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: "https://lazyrelay.com" },
  });
  if (linkError || !linkData) throw linkError ?? new Error("no link returned");

  console.log("ACCOUNT_ID:", accountId);
  console.log("LOGIN_LINK:", linkData.properties.action_link);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
