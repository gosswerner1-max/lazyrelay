import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createResilientFetch } from "./db/resilientFetch.js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !serviceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Copy .env.example to .env and fill them in once the Supabase project exists.",
  );
}

// One resilient fetch shared by every client below (and by their auth and
// storage sub-clients), so the timeout, the in-flight cap, the keep-alive pool
// and the GET retry for gateway errors (522 and friends) apply process-wide.
// See db/resilientFetch.ts. db.retry is off because that layer does the
// retrying: leaving supabase-js's own GET retry on would multiply the attempts.
const resilientFetch = createResilientFetch();

// Service-role client — used only by backend code (scheduling engine, webhook
// handlers, platform posting). Never expose this key to a browser/frontend;
// the frontend gets its own anon-key client scoped by RLS.
export const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: resilientFetch },
  db: { retry: false },
});

// Per-request authenticated client — added for the RLS rework (2026-09-04).
// Built from req.rawToken (see auth.ts's requireAuth, JWT branch only) so
// Postgres's own RLS policies (migration 0081 on) become the real
// enforcement for whichever routes opt into this, instead of relying
// solely on that route's own account_id filter. The anon key alone grants
// nothing — it's the same key already public in the deployed frontend
// bundle; the *token* in the Authorization header is what RLS actually
// evaluates via auth.uid(). Deliberately a NEW client per call, not a
// shared singleton: each one is scoped to exactly one request's caller
// and must never be reused across requests/users.
export function createUserClient(rawToken: string): SupabaseClient {
  if (!anonKey) {
    throw new Error("SUPABASE_ANON_KEY must be set to build a per-request authenticated client.");
  }
  // autoRefreshToken is off on purpose: the caller's token is fixed for the
  // life of one request. Left on (the default), auth-js starts a 30 s interval
  // timer inside every client, and because a client is built per request that
  // is one timer, never cleared, per authenticated request.
  return createClient(url!, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${rawToken}` }, fetch: resilientFetch },
    db: { retry: false },
  });
}
