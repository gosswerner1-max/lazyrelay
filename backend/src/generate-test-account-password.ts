import "dotenv/config";
import { supabase } from "./supabase.js";

// One-off helper: creates a throwaway test account with a real password,
// for cases (e.g. an App Review demo video) where the actual human
// sign-in form needs to be shown on camera rather than bypassed via a
// magic link. Prints the credentials so Werner can type them in himself —
// this script only provisions the account, it never authenticates with it.

async function main() {
  const email = `meta-review-demo-${Date.now()}@lazyrelay.invalid`;
  const password = "MetaReview2026!" + Math.floor(Math.random() * 9000 + 1000);
  const { data: user, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !user.user) throw error ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  console.log("ACCOUNT_ID:", accountId);
  console.log("EMAIL:", email);
  console.log("PASSWORD:", password);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
