import { supabase } from "../supabase.js";

/**
 * Grandfathered ("legacy") accounts are never metered, capped or paused by the wallet (owner decision 2026-10-19; the list is
 * wallet_legacy_accounts, migration 0139). Every wallet check asks this one function. The answer is cached for 60 seconds per account.
 * If the read fails the answer is TRUE and the failure is logged, so a database hiccup can never meter or cap an old customer. A failed
 * read is not cached.
 */
const LEGACY_CACHE_TTL_MS = 60_000;
const cache = new Map<string, { legacy: boolean; expiresAt: number }>();

export async function isLegacyAccount(accountId: string): Promise<boolean> {
  const hit = cache.get(accountId);
  if (hit && hit.expiresAt > Date.now()) return hit.legacy;

  const { data, error } = await supabase.from("wallet_legacy_accounts").select("account_id").eq("account_id", accountId).maybeSingle();
  if (error) {
    console.error("[wallet] isLegacyAccount read failed, treating the account as legacy:", error.message);
    return true;
  }
  const legacy = data != null;
  cache.set(accountId, { legacy, expiresAt: Date.now() + LEGACY_CACHE_TTL_MS });
  return legacy;
}
