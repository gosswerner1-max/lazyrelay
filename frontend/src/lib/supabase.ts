import { createClient } from "@supabase/supabase-js";

// Anon/publishable key only — this is the browser client, RLS on every
// table (per the backend schema) is what actually protects data here, not
// secrecy of this key. Never put the service_role key in frontend code.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
