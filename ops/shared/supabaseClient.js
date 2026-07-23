// Shared Supabase client for every ops domain — service-role access,
// same client shape as backend/src/supabase.ts, but this is a separate
// process (ops scripts run standalone/via scheduled task, not inside the
// backend server), so it gets its own thin wrapper rather than importing
// TS backend code directly.

const { createClient } = require("@supabase/supabase-js");
const { getSupabaseCredentials } = require("../config/credentials.js");

function getSupabaseClient() {
  const { url, serviceRoleKey } = getSupabaseCredentials();
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

module.exports = { getSupabaseClient };
