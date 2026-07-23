import "dotenv/config";
import { supabase } from "./supabase.js";
import { checkQuotaForNewUpload, getStorageUsage, STORAGE_QUOTA_BYTES } from "./storageQuota.js";

// One-off smoke test — proves the storage quota + usage gauge work end to
// end against the real Supabase project: usage starts empty, grows as
// uploads are recorded, rejects a file that would exceed quota, and shrinks
// back down after a delete (the actual customer-facing "delete your own
// files to make space" flow this whole feature exists for).

async function main() {
  const email = `storage-quota-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email }); // handle_new_user() may already have created it

  let pass = true;

  // Free tier (no subscription row) — quota should be the Free number.
  const initialUsage = await getStorageUsage(accountId);
  console.log("Initial usage (fresh free account):", initialUsage);
  if (initialUsage.usedBytes !== 0 || initialUsage.quotaBytes !== STORAGE_QUOTA_BYTES.free) {
    console.error("FAIL: expected 0 used bytes and the Free quota for a fresh account.");
    pass = false;
  }

  // Insert a file using most of the Free quota (200MB of the 250MB cap).
  const bigFileBytes = 200 * 1024 * 1024;
  const firstUrl = `https://example.invalid/quota-test-1-${Date.now()}.jpg`;
  await supabase.from("media_uploads").insert({
    account_id: accountId,
    url: firstUrl,
    storage_path: `${accountId}/quota-test-1.jpg`,
    mime_type: "image/jpeg",
    size_bytes: bigFileBytes,
    width: 1080,
    height: 1080,
  });

  const usageAfterFirst = await getStorageUsage(accountId);
  console.log("Usage after 200MB upload:", usageAfterFirst);
  if (usageAfterFirst.usedBytes !== bigFileBytes) {
    console.error("FAIL: usage should reflect the 200MB just recorded.");
    pass = false;
  }

  // A second 100MB file would push total to 300MB, over the 250MB Free
  // quota — this is the exact rejection the customer would see.
  const rejection = await checkQuotaForNewUpload(accountId, 100 * 1024 * 1024);
  console.log("Rejection for a file that would exceed quota:", rejection);
  if (!rejection || !rejection.includes("storage limit")) {
    console.error("FAIL: expected a quota-exceeded rejection message.");
    pass = false;
  } else {
    console.log("PASS: oversized-relative-to-remaining-quota upload correctly rejected.");
  }

  // A small 10MB file still fits (200MB + 10MB = 210MB < 250MB) — quota
  // check should allow it (return null = no rejection).
  const allowed = await checkQuotaForNewUpload(accountId, 10 * 1024 * 1024);
  if (allowed !== null) {
    console.error(`FAIL: a file that still fits should be allowed (null), got: ${allowed}`);
    pass = false;
  } else {
    console.log("PASS: a file that still fits within quota is correctly allowed.");
  }

  // Delete the big file — usage should drop back to 0, freeing up space,
  // proving the actual "delete your own files to make room" flow works.
  await supabase.from("media_uploads").delete().eq("url", firstUrl);
  const usageAfterDelete = await getStorageUsage(accountId);
  console.log("Usage after deleting the 200MB file:", usageAfterDelete);
  if (usageAfterDelete.usedBytes !== 0) {
    console.error("FAIL: usage should be back to 0 after deleting the only file.");
    pass = false;
  } else {
    console.log("PASS: deleting a file frees up quota, confirmed via usage dropping back to 0.");
  }

  await supabase.auth.admin.deleteUser(accountId);
  console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
