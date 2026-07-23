import "dotenv/config";
import { supabase } from "./supabase.js";

// One-off helper: creates a throwaway test account and generates a
// passwordless magic sign-in link for it via the admin API, so the
// Settings/storage-gauge UI can be visually checked in a real browser
// session without ever touching a password. Prints the account id so it
// can be cleaned up afterward.

async function main() {
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
