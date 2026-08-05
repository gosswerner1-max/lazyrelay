// Shared Supabase Storage usage/overage calculation — used by both the
// weekly customer report and the daily health check, so the two never
// drift out of sync on what "overage" means.
//
// Supabase Pro plan ($25/mo) includes 100GB of Storage, metered beyond
// that. Verify these two numbers against Supabase's current pricing page
// periodically — this is the one cost figure in the whole ops/ stack that
// isn't a live API read.
const SUPABASE_STORAGE_INCLUDED_GB = 100;
const SUPABASE_STORAGE_OVERAGE_PER_GB_USD = 0.021;

async function gatherStorageUsage(supabase) {
  const { data, error } = await supabase.from("media_uploads").select("size_bytes");
  if (error) throw error;

  const totalBytes = (data ?? []).reduce((sum, row) => sum + row.size_bytes, 0);
  const totalGb = totalBytes / (1024 * 1024 * 1024);
  const overageGb = Math.max(0, totalGb - SUPABASE_STORAGE_INCLUDED_GB);
  const overageCostUsd = overageGb * SUPABASE_STORAGE_OVERAGE_PER_GB_USD;

  return { totalGb, includedGb: SUPABASE_STORAGE_INCLUDED_GB, overageGb, overageCostUsd };
}

// Real storage add-on prices (project-storage-addons-2026-07-23) — verify
// against Paddle/the live pricing page periodically, same discipline as the
// Supabase overage constants above.
const STORAGE_ADDON_PRICES_USD = { 5: 2.99, 20: 7.99, 50: 14.99 };

/** Real cost (what Supabase bills LazyRelay for total storage overage)
 *  vs real revenue (what active/trialing storage_addons subscriptions are
 *  worth) — this is the actual margin question, not a raw GB number. A
 *  customer's paid storage physically shares the same pool that drives
 *  Supabase's bill (see 2026-08-05 conversation), so cost isn't zero just
 *  because it's "their" storage — but revenue should always cover it by a
 *  wide margin per the known per-GB prices above. This function reports
 *  the real numbers so that margin gets verified, not assumed. */
async function computeStorageMargin(supabase, storageUsage) {
  const { data, error } = await supabase.from("storage_addons").select("gb_amount, status").in("status", ["active", "trialing"]);
  if (error) throw error;
  const addons = data ?? [];
  const monthlyRevenueUsd = addons.reduce((sum, a) => sum + (STORAGE_ADDON_PRICES_USD[a.gb_amount] ?? 0), 0);
  const monthlyCostUsd = storageUsage.overageCostUsd;
  const marginUsd = monthlyRevenueUsd - monthlyCostUsd;
  // Only meaningful once there's real overage cost to weigh against revenue
  // — at $0 cost (current state, 2GB of 100GB used) margin is trivially
  // fine regardless of how many add-ons are sold, nothing to flag.
  const marginRatio = monthlyCostUsd > 0 ? marginUsd / monthlyCostUsd : null;
  return {
    activeAddonCount: addons.length,
    monthlyRevenueUsd,
    monthlyCostUsd,
    marginUsd,
    marginRatio, // null, or a number where e.g. 5 means revenue is 5x cost
  };
}

module.exports = {
  gatherStorageUsage,
  computeStorageMargin,
  SUPABASE_STORAGE_INCLUDED_GB,
  SUPABASE_STORAGE_OVERAGE_PER_GB_USD,
  STORAGE_ADDON_PRICES_USD,
};
