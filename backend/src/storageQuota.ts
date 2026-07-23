import { supabase } from "./supabase.js";
import { resolveTier, type Tier } from "./tier.js";

/** Per-account storage quota — the actual defense against the "upload media
 *  that's never attached to a post, forever, for free" cost-abuse gap found
 *  2026-07-23. Deliberately simple: we never delete a customer's files
 *  ourselves. Once an account is at its quota, new uploads are rejected
 *  until the customer deletes something or upgrades — same model as
 *  Google Drive/Dropbox's own storage gauge, not a notice-and-delete policy.
 *  Numbers below are a starting point, easy to tune later; they aren't tied
 *  to any external research, just a reasonable per-tier scale-up. */
const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export const STORAGE_QUOTA_BYTES: Record<Tier, number> = {
  free: 250 * MB,
  pro: 5 * GB, // "Starter"
  business: 10 * GB, // "Pro"
  enterprise: 20 * GB, // "Business"
};

export interface StorageUsage {
  tier: Tier;
  usedBytes: number;
  quotaBytes: number;
  addonBytes: number;
}

/** Sum of all active/trialing storage add-ons for this account, in bytes.
 *  Free-tier accounts can't purchase add-ons (see routes.ts), so this is
 *  always 0 for them in practice — not special-cased here since the
 *  underlying query is correct regardless. */
async function getActiveAddonBytes(accountId: string): Promise<number> {
  const { data, error } = await supabase
    .from("storage_addons")
    .select("gb_amount")
    .eq("account_id", accountId)
    .in("status", ["active", "trialing"]);
  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + row.gb_amount * GB, 0);
}

export async function getStorageUsage(accountId: string): Promise<StorageUsage> {
  const tier = await resolveTier(accountId);
  const [{ data, error }, addonBytes] = await Promise.all([
    supabase.from("media_uploads").select("size_bytes").eq("account_id", accountId),
    getActiveAddonBytes(accountId),
  ]);
  if (error) throw error;
  const usedBytes = (data ?? []).reduce((sum, row) => sum + row.size_bytes, 0);
  return { tier, usedBytes, quotaBytes: STORAGE_QUOTA_BYTES[tier] + addonBytes, addonBytes };
}

/** Checked BEFORE accepting a new upload — returns a customer-facing reason
 *  if it would push the account over quota, or null if there's room. */
export async function checkQuotaForNewUpload(accountId: string, newFileBytes: number): Promise<string | null> {
  const usage = await getStorageUsage(accountId);
  if (usage.usedBytes + newFileBytes <= usage.quotaBytes) return null;

  const usedMB = (usage.usedBytes / MB).toFixed(1);
  const quotaMB = (usage.quotaBytes / MB).toFixed(0);
  const upgradeHint = usage.tier === "enterprise" ? " Please" : " Upgrade, buy more storage, or";
  return `You're using ${usedMB}MB of your ${quotaMB}MB storage limit — this file won't fit.${upgradeHint} delete some existing media to free up space.`;
}
