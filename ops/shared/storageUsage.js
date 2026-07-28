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

module.exports = { gatherStorageUsage, SUPABASE_STORAGE_INCLUDED_GB, SUPABASE_STORAGE_OVERAGE_PER_GB_USD };
