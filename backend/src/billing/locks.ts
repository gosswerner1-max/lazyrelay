import { supabase } from "../supabase.js";

// SECURITY FIX (2026-09-25): replaces routes.ts's old in-memory
// `pendingTierChanges` Set -- see migration 0091_billing_action_locks.sql's
// own comment for the full reasoning (that Set doesn't survive Render's
// zero-downtime deploy overlap, where two processes each have their own
// empty Set). Generous headroom over any real checkout/Paddle-API-call
// latency (normally well under a second) while short enough that a process
// that crashed mid-request self-heals within a customer's realistic retry
// window, not minutes later.
const LOCK_TTL_MS = 30_000;

/** Acquires the durable, cross-process billing-action lock for `accountId`.
 *  Returns true if the lock was acquired -- the caller MUST release it via
 *  releaseBillingLock in a `finally` block, exactly the same shape the old
 *  Set.add()/Set.delete() pair already had. Returns false if another
 *  process already holds a live (non-expired) lock for this account, in
 *  which case the caller should reject the request the same way it used to
 *  reject on `pendingTierChanges.has(accountId)`.
 *
 *  Same atomic-conditional-update-then-upsert-fallback shape already used
 *  twice elsewhere in this codebase for exactly this class of race (see
 *  billing/sync.ts's syncSubscriptionFromWebhook/applyAddonEvent) -- the
 *  UPDATE ... WHERE is what actually makes this race-safe (Postgres's own
 *  row lock serializes concurrent attempts against the same account_id row),
 *  the INSERT only fires for a genuinely first-ever lock row for this
 *  account. */
export async function acquireBillingLock(accountId: string, action: string): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS).toISOString();

  // Case 1: a lock row already exists for this account but has expired (a
  // prior holder crashed without releasing, or a Render deploy overlap
  // orphaned it) -- steal it atomically. Two concurrent callers can never
  // both win this UPDATE: Postgres evaluates each one's WHERE clause against
  // whatever the row actually holds at the time it acquires that row's lock,
  // so the loser's WHERE simply no longer matches once the winner commits.
  const { data: stolen, error: stealError } = await supabase
    .from("billing_action_locks")
    .update({ action, expires_at: expiresAt, created_at: now.toISOString() })
    .eq("account_id", accountId)
    .lt("expires_at", now.toISOString())
    .select("account_id");
  if (stealError) throw stealError;
  if ((stolen ?? []).length > 0) return true;

  // Case 2: no row exists yet for this account -- plain insert. onConflict +
  // ignoreDuplicates makes this a no-op (returns nothing) if a LIVE lock
  // already exists (real contention from a concurrent request), rather than
  // throwing a 23505 or clobbering it.
  const { data: inserted, error: insertError } = await supabase
    .from("billing_action_locks")
    .upsert({ account_id: accountId, action, expires_at: expiresAt, created_at: now.toISOString() }, { onConflict: "account_id", ignoreDuplicates: true })
    .select("account_id");
  if (insertError) throw insertError;
  if ((inserted ?? []).length > 0) return true;

  // Case 3: the insert no-op'd because a row already existed at that exact
  // moment -- either a live lock (real contention, correctly fails below) or
  // one that expired in the narrow window between the UPDATE in Case 1 and
  // this INSERT. Re-running the same conditional steal resolves either case
  // correctly (mirrors sync.ts's own re-run-the-conditional-update comment
  // for the identical ambiguity in the webhook-ordering guard).
  const { data: retried, error: retryError } = await supabase
    .from("billing_action_locks")
    .update({ action, expires_at: expiresAt, created_at: now.toISOString() })
    .eq("account_id", accountId)
    .lt("expires_at", now.toISOString())
    .select("account_id");
  if (retryError) throw retryError;
  return (retried ?? []).length > 0;
}

/** Releases the lock -- best-effort, called from routes.ts's `finally`
 *  block same as the old Set.delete() was. Must never throw past a response
 *  that's already been sent; expires_at is the real backstop if this delete
 *  fails or the process dies before it runs. */
export async function releaseBillingLock(accountId: string): Promise<void> {
  const { error } = await supabase.from("billing_action_locks").delete().eq("account_id", accountId);
  if (error) {
    console.error(`[billing/locks] Failed to release billing lock for account ${accountId}:`, error.message);
  }
}
