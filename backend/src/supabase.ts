import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Copy .env.example to .env and fill them in once the Supabase project exists.",
  );
}

// Service-role client — used only by backend code (scheduling engine, webhook
// handlers, platform posting). Never expose this key to a browser/frontend;
// the frontend gets its own anon-key client scoped by RLS.
export const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false },
});
