import "dotenv/config";
import { supabase } from "./supabase.js";

// Read-only diagnostic — checks whether any real subscriptions exist and
// what tier/status they're in, to answer "are there real paying customers
// right now, and were they set up against Sandbox or Live Paddle?"
async function main() {
  const { data: subs, error } = await supabase
    .from("subscriptions")
    .select("account_id, tier, status, created_at")
    .neq("tier", "free");
  if (error) throw error;

  console.log(`Non-free subscription rows: ${subs?.length ?? 0}`);
  for (const s of subs ?? []) {
    console.log(`  account=${s.account_id} tier=${s.tier} status=${s.status} created=${s.created_at}`);
  }

  const { count: accountCount } = await supabase.from("accounts").select("id", { count: "exact", head: true });
  console.log(`Total accounts (all tiers): ${accountCount}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
