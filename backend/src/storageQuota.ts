import { supabase } from "./supabase.js";

/** Per-account storage quota — the actual defense against the "upload media
 *  that's never attached to a post, forever, for free" cost-abuse gap found
 *  2026-07-23. Deliberately simple: we never delete a customer's files
 *  ourselves. Once an account is at its quota, new uploads are rejected
 *  until the customer deletes something or upgrades — same model as
 *  Google Drive/Dropbox's own storage gauge, not a notice-and-delete policy.
 *  Numbers below are a starting point, easy to tune later; they aren't tied
 *  to any external research, just a reasonable per-tier scale-up. */
export type Tier = "free" | "pro" | "business";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export const STORAGE_QUOTA_BYTES: Record<Tier, number> = {
  free: 250 * MB,
  pro: 5 * GB,
  business: 20 * GB,
};

export interface StorageUsage {
  tier: Tier;
  usedBytes: number;
  quotaBytes: number;
}

async function resolveTier(accountId: string): Promise<Tier> {
  const { data } = await supabase.from("subscriptions").select("tier, status").eq("account_id", accountId).maybeSingle();
  const isPaidInGoodStanding = data?.tier !== "free" && (data?.status === "active" || data?.status === "trialing");
  return isPaidInGoodStanding ? (data!.tier as Tier) : "free";
}

export async function getStorageUsage(accountId: string): Promise<StorageUsage> {
  const tier = await resolveTier(accountId);
  const { data, error } = await supabase.from("media_uploads").select("size_bytes").eq("account_id", accountId);
  if (error) throw error;
  const usedBytes = (data ?? []).reduce((sum, row) => sum + row.size_bytes, 0);
  return { tier, usedBytes, quotaBytes: STORAGE_QUOTA_BYTES[tier] };
}

/** Checked BEFORE accepting a new upload — returns a customer-facing reason
 *  if it would push the account over quota, or null if there's room. */
export async function checkQuotaForNewUpload(accountId: string, newFileBytes: number): Promise<string | null> {
  const usage = await getStorageUsage(accountId);
  if (usage.usedBytes + newFileBytes <= usage.quotaBytes) return null;

  const usedMB = (usage.usedBytes / MB).toFixed(1);
  const quotaMB = (usage.quotaBytes / MB).toFixed(0);
  const upgradeHint = usage.tier === "free" ? " Upgrade to Pro for more storage, or" : " Please";
  return `You're using ${usedMB}MB of your ${quotaMB}MB storage limit — this file won't fit.${upgradeHint} delete some existing media to free up space.`;
}
