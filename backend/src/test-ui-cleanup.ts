import "dotenv/config";
import { supabase } from "./supabase.js";

async function main() {
  const accountId = process.argv[2];
  if (!accountId) throw new Error("usage: test-ui-cleanup.ts <account_id>");
  await supabase.auth.admin.deleteUser(accountId);
  console.log("Deleted test user and cascaded rows:", accountId);
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
