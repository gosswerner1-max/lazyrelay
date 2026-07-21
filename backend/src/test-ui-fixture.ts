import "dotenv/config";
import { supabase } from "./supabase.js";

// Creates a confirmed test user for manual UI testing through the browser.
// Prints credentials; does NOT clean up — call test-ui-fixture-cleanup.ts after.
async function main() {
  const email = `ui-test-${Date.now()}@lazyrelay.invalid`;
  const password = "ui-test-password-123";
  const { data: user, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !user.user) throw error ?? new Error("no user returned");
  console.log(JSON.stringify({ email, password, id: user.user.id }));
}

main().catch((err) => {
  console.error("Fixture creation failed:", err);
  process.exit(1);
});
