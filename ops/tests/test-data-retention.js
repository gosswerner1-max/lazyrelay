// Live, real-database verification for data_retention_ops.js (2026-08-15) —
// same discipline as backend/src/test-cancel.ts: seeds a genuine throwaway
// account via the real Supabase admin API, runs the real functions against
// it, checks real results, cleans up after itself. Not wired into
// runSelfTest.js's harness (different shape) — run directly:
//   node ops/tests/test-data-retention.js
//
// Uses a plain @example.com address deliberately, NOT @lazyrelay.invalid --
// isInternalTestAccount() excludes that domain, which would make the
// find-functions skip this account and defeat the point of testing them.

const { getSupabaseClient } = require("../shared/supabaseClient.js");
const {
  findAccountsNeedingReminder,
  findAccountsPastGracePeriod,
  deleteAccountData,
} = require("../accounts/data_retention_ops.js");

const supabase = getSupabaseClient();

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

async function seedAccount(emailPrefix, cancelledDaysAgo, subStatus) {
  const email = `${emailPrefix}-${Date.now()}@example.com`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user created");
  const accountId = user.user.id;

  // A DB trigger auto-creates the accounts row on auth.users insert (found
  // live while building this test — production code never hits this since
  // syncSubscriptionFromWebhook always UPDATEs an existing row, never
  // INSERTs), so this has to be an update, not an insert.
  const { error: updateError } = await supabase
    .from("accounts")
    .update({ cancelled_at: cancelledDaysAgo === null ? null : daysAgo(cancelledDaysAgo) })
    .eq("id", accountId);
  if (updateError) throw updateError;
  await supabase.from("subscriptions").insert({
    account_id: accountId,
    tier: "free",
    status: subStatus,
    mor_subscription_id: `mor_test_${Date.now()}`,
    current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  });
  return { accountId, email };
}

async function seedMediaFile(accountId) {
  const storagePath = `test-data-retention/${accountId}.txt`;
  const { error: uploadError } = await supabase.storage
    .from("post-media")
    .upload(storagePath, Buffer.from("throwaway test file content"), { contentType: "text/plain" });
  if (uploadError) throw uploadError;

  const { data: url } = supabase.storage.from("post-media").getPublicUrl(storagePath);
  await supabase.from("media_uploads").insert({
    account_id: accountId,
    url: url.publicUrl,
    storage_path: storagePath,
    mime_type: "text/plain",
    size_bytes: 27,
  });
  return storagePath;
}

async function cleanup(accountId) {
  await supabase.auth.admin.deleteUser(accountId);
}

async function main() {
  const results = [];

  // Test 1: an account past the grace period, no active subscription --
  // should be found by both finders, and deleteAccountData should actually
  // remove the storage file, the media_uploads row, and mark data_deleted_at.
  {
    const { accountId, email } = await seedAccount("del-test", 31, "cancelled");
    const storagePath = await seedMediaFile(accountId);
    await supabase.from("scheduled_posts").insert({
      account_id: accountId,
      social_account_id: "00000000-0000-0000-0000-000000000000",
      content: "throwaway test post",
      scheduled_for: new Date().toISOString(),
      status: "posted",
    }).then(() => {}).catch(() => {
      // social_account_id FK will fail without a real social_accounts row --
      // acceptable, this test's primary target is media/storage deletion,
      // not the scheduled_posts cascade specifically (that's a plain FK
      // cascade already exercised elsewhere in this codebase).
    });

    const reminderCandidates = await findAccountsNeedingReminder(supabase);
    const deletionCandidates = await findAccountsPastGracePeriod(supabase);
    const foundForReminder = reminderCandidates.some((a) => a.id === accountId);
    const foundForDeletion = deletionCandidates.some((a) => a.id === accountId);

    const deleteResult = await deleteAccountData(supabase, { id: accountId, email });

    const { data: fileStillThere } = await supabase.storage.from("post-media").list("test-data-retention");
    const fileGone = !(fileStillThere ?? []).some((f) => f.name === storagePath.split("/").pop());

    const { data: mediaRow } = await supabase.from("media_uploads").select("id").eq("account_id", accountId);
    const { data: acctRow } = await supabase.from("accounts").select("data_deleted_at").eq("id", accountId).single();

    results.push({
      test: "past-grace-period account gets fully deleted",
      foundForReminder,
      foundForDeletion,
      deleteResult,
      fileGone,
      mediaRowsRemaining: (mediaRow ?? []).length,
      dataDeletedAtSet: !!acctRow?.data_deleted_at,
      PASS: foundForDeletion && deleteResult.deleted === true && fileGone && (mediaRow ?? []).length === 0 && !!acctRow?.data_deleted_at,
    });

    await cleanup(accountId);
  }

  // Test 2: resubscribe safety -- cancelled_at is 31 days ago (would match
  // the query), but the real subscription status is "active" again.
  // deleteAccountData must refuse to delete.
  {
    const { accountId, email } = await seedAccount("resub-test", 31, "active");
    const deleteResult = await deleteAccountData(supabase, { id: accountId, email });
    results.push({
      test: "resubscribed account is NOT deleted despite stale cancelled_at",
      deleteResult,
      PASS: deleteResult.deleted === false,
    });
    await cleanup(accountId);
  }

  // Test 3: an account cancelled only 5 days ago -- should NOT show up in
  // either finder yet (too early for both the day-23 reminder and the
  // day-30 deletion).
  {
    const { accountId, email } = await seedAccount("too-early-test", 5, "cancelled");
    const reminderCandidates = await findAccountsNeedingReminder(supabase);
    const deletionCandidates = await findAccountsPastGracePeriod(supabase);
    const wronglyFoundForReminder = reminderCandidates.some((a) => a.id === accountId);
    const wronglyFoundForDeletion = deletionCandidates.some((a) => a.id === accountId);
    results.push({
      test: "recently-cancelled account is NOT yet a candidate for either pass",
      wronglyFoundForReminder,
      wronglyFoundForDeletion,
      PASS: !wronglyFoundForReminder && !wronglyFoundForDeletion,
    });
    await cleanup(accountId);
  }

  console.log(JSON.stringify(results, null, 2));
  const allPass = results.every((r) => r.PASS);
  console.log(allPass ? "\nALL TESTS PASS" : "\nSOME TESTS FAILED");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run threw:", err);
  process.exit(1);
});
