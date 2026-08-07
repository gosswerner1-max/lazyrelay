import "dotenv/config";
import { randomBytes } from "node:crypto";
import { supabase } from "./supabase.js";
import { ADMIN_API_KEY_PREFIX, hashApiKey } from "./http/auth.js";

// One-off: mint a real admin API key (acts across every account, see
// http/auth.ts's requireAuth admin path). Not tied to any tenant's
// dashboard — there's no UI for this key type by design, since it isn't
// scoped to one customer. Run once per key needed; the raw value is only
// ever shown here, at creation, same as the customer-facing api_keys flow.
async function main() {
  const name = process.argv[2];
  if (!name) throw new Error("usage: create-admin-key.ts <name>");

  const rawKey = `${ADMIN_API_KEY_PREFIX}${randomBytes(24).toString("hex")}`;
  const { data, error } = await supabase
    .from("admin_api_keys")
    .insert({ name, key_prefix: rawKey.slice(0, ADMIN_API_KEY_PREFIX.length + 6), key_hash: hashApiKey(rawKey) })
    .select("id")
    .single();
  if (error) throw error;

  console.log(`Created admin key "${name}" (id ${data.id})`);
  console.log(`\nCopy this now — it will never be shown again:\n${rawKey}\n`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
