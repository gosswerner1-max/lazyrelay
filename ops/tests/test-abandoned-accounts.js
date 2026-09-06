// Live, real-database verification for abandoned_account_ops.js
// (2026-09-06) — same discipline as test-data-retention.js: seeds genuine
// throwaway accounts via the real Supabase admin API, runs the real
// functions against them, checks real results, cleans up after itself.
// Run directly: node ops/tests/test-abandoned-accounts.js
//
// Uses `@<label>.invalid` addresses that do NOT match the
// `/@lazyrelay\.invalid$/i` pattern in internalTestAccounts.js (a different
// second-level domain under the same RFC 2606-reserved .invalid TLD) --
// deliberately NOT @lazyrelay.invalid or @example.com/.org/.net, both of
// which ARE filtered by isInternalTestAccount() and would make every
// find-function skip these fixtures, defeating the point of the test.

const { getSupabaseClient } = require("../shared/supabaseClient.js");
const {
  findAccountsNeedingReminder1,
  findAccountsNeedingReminder2,
  findAccountsPastAbandonmentThreshold,
  deleteAbandonedAccount,
  isCurrentlyAbandoned,
  REMINDER_1_AT_DAYS,
  REMINDER_2_AT_DAYS,
  ABANDONMENT_DAYS,
} = require("../accounts/abandoned_account_ops.js");

const supabase = getSupabaseClient();

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

async function seedAccount(label, createdDaysAgo, opts = {}) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@abandoned-fixture.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user created");
  const accountId = user.user.id;

  // A DB trigger auto-creates the accounts row on auth.users insert (same
  // gotcha test-data-retention.js's own comment documents), so this is an
  // UPDATE, not an INSERT.
  const { error: updateError } = await supabase
    .from("accounts")
    .update({
      created_at: daysAgo(createdDaysAgo),
      cancelled_at: opts.cancelledAt ?? null,
      abandonment_reminder_1_sent_at: opts.reminder1DaysAgo === undefined ? null : daysAgo(opts.reminder1DaysAgo),
      abandonment_reminder_2_sent_at: opts.reminder2DaysAgo === undefined ? null : daysAgo(opts.reminder2DaysAgo),
    })
    .eq("id", accountId);
  if (updateError) throw updateError;

  if (opts.subscriptionStatus) {
    const { error: subError } = await supabase.from("subscriptions").insert({
      account_id: accountId,
      tier: opts.subscriptionTier ?? "pro",
      status: opts.subscriptionStatus,
      mor_subscription_id: `mor_abandon_test_${Date.now()}_${Math.random()}`,
      current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    });
    if (subError) throw subError;
  }

  if (opts.withSocialAccount) {
    const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
      p_token: `abandon-test-token-${Date.now()}-${Math.random()}`,
    });
    if (vaultError) throw vaultError;
    const { error: socialError } = await supabase.from("social_accounts").insert({
      account_id: accountId,
      platform: "meta",
      platform_account_id: `abandon-test-page-${Date.now()}-${Math.random()}`,
      display_name: "Abandon Test Page",
      access_token_vault_id: vaultId,
    });
    if (socialError) throw socialError;
  }

  if (opts.withPost) {
    // Needs a real social_accounts row to satisfy the FK, independent of
    // whether withSocialAccount was also requested (a post can exist even
    // if the social account was later disconnected -- not this test's
    // concern, just needs a valid FK target).
    const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
      p_token: `abandon-test-post-token-${Date.now()}-${Math.random()}`,
    });
    if (vaultError) throw vaultError;
    const { data: social, error: socialError } = await supabase
      .from("social_accounts")
      .insert({
        account_id: accountId,
        platform: "meta",
        platform_account_id: `abandon-test-post-page-${Date.now()}-${Math.random()}`,
        display_name: "Abandon Test Post Page",
        access_token_vault_id: vaultId,
      })
      .select("id")
      .single();
    if (socialError) throw socialError;
    const { error: postError } = await supabase.from("scheduled_posts").insert({
      account_id: accountId,
      social_account_id: social.id,
      content: "throwaway abandoned-account test post",
      scheduled_for: new Date(Date.now() + 3600_000).toISOString(),
    });
    if (postError) throw postError;
  }

  return { accountId, email };
}

async function cleanup(accountId) {
  try {
    await supabase.auth.admin.deleteUser(accountId);
  } catch {
    /* best effort -- deleteAbandonedAccount already removed it in the success path */
  }
}

async function main() {
  const results = [];

  // Test 1: the real target case — 181 days old, never cancelled, zero
  // social accounts, zero posts, no subscription, reminded twice with a
  // real 4-day gap since the second reminder. Must be found by
  // findAccountsPastAbandonmentThreshold and actually deleted: accounts
  // row AND auth user both gone afterward.
  {
    const { accountId, email } = await seedAccount("del-test", 181, { reminder1DaysAgo: 15, reminder2DaysAgo: 4 });
    const candidates = await findAccountsPastAbandonmentThreshold(supabase);
    const found = candidates.some((a) => a.id === accountId);
    const account = candidates.find((a) => a.id === accountId) ?? { id: accountId, email };
    const deleteResult = await deleteAbandonedAccount(supabase, account);

    const { data: accountRow } = await supabase.from("accounts").select("id").eq("id", accountId).maybeSingle();
    const { data: authUsers } = await supabase.auth.admin.listUsers();
    const authUserGone = !authUsers.users.some((u) => u.id === accountId);

    results.push({
      test: "181-days-old, never-configured, twice-reminded account is deleted (account row AND auth user both gone)",
      found,
      deleteResult,
      accountRowGone: !accountRow,
      authUserGone,
      PASS: found && deleteResult.deleted === true && !accountRow && authUserGone,
    });
    // Already deleted by the function under test -- no cleanup() call here.
  }

  // Test 2: paid exemption — 181 days old, zero social accounts, zero
  // posts, but an ACTIVE subscription. Must never appear as a candidate for
  // anything, and deleteAbandonedAccount must refuse if called directly.
  {
    const { accountId, email } = await seedAccount("paid-test", 181, {
      reminder1DaysAgo: 15,
      reminder2DaysAgo: 4,
      subscriptionStatus: "active",
      subscriptionTier: "pro",
    });
    const stillAbandoned = await isCurrentlyAbandoned(supabase, accountId);
    const deletionCandidates = await findAccountsPastAbandonmentThreshold(supabase);
    const wronglyFoundForDeletion = deletionCandidates.some((a) => a.id === accountId);
    const deleteResult = await deleteAbandonedAccount(supabase, { id: accountId, email });
    results.push({
      test: "paid (active subscription) account is exempt no matter what — never a candidate, refuses direct delete",
      stillAbandoned,
      wronglyFoundForDeletion,
      deleteResult,
      PASS: stillAbandoned === false && !wronglyFoundForDeletion && deleteResult.deleted === false,
    });
    await cleanup(accountId);
  }

  // Test 3: has a connected social account — must not qualify as abandoned
  // even though it's old and never cancelled.
  {
    const { accountId } = await seedAccount("has-social-test", 181, {
      reminder1DaysAgo: 15,
      reminder2DaysAgo: 4,
      withSocialAccount: true,
    });
    const stillAbandoned = await isCurrentlyAbandoned(supabase, accountId);
    results.push({
      test: "account with a connected social account is NOT abandoned regardless of age",
      stillAbandoned,
      PASS: stillAbandoned === false,
    });
    await cleanup(accountId);
  }

  // Test 4: has a scheduled post — must not qualify as abandoned.
  {
    const { accountId } = await seedAccount("has-post-test", 181, {
      reminder1DaysAgo: 15,
      reminder2DaysAgo: 4,
      withPost: true,
    });
    const stillAbandoned = await isCurrentlyAbandoned(supabase, accountId);
    results.push({
      test: "account with a scheduled post is NOT abandoned regardless of age",
      stillAbandoned,
      PASS: stillAbandoned === false,
    });
    await cleanup(accountId);
  }

  // Test 5: ever-cancelled account — even if zero activity and old, this
  // is data_retention_ops.js's territory, never this module's. Must never
  // appear in any of the three candidate lists.
  {
    const { accountId } = await seedAccount("was-cancelled-test", 181, {
      cancelledAt: daysAgo(181),
      reminder1DaysAgo: 15,
      reminder2DaysAgo: 4,
    });
    const r1 = await findAccountsNeedingReminder1(supabase);
    const r2 = await findAccountsNeedingReminder2(supabase);
    const del = await findAccountsPastAbandonmentThreshold(supabase);
    const wronglyFound = [r1, r2, del].some((list) => list.some((a) => a.id === accountId));
    results.push({
      test: "an ever-cancelled account never appears on any abandoned-account list (that's data_retention_ops.js's job)",
      wronglyFound,
      PASS: !wronglyFound,
    });
    await cleanup(accountId);
  }

  // Test 6: too young for reminder 1 (100 days old) — must not appear on
  // any list yet.
  {
    const { accountId } = await seedAccount("too-young-test", 100);
    const r1 = await findAccountsNeedingReminder1(supabase);
    const wronglyFound = r1.some((a) => a.id === accountId);
    results.push({
      test: "a 100-day-old account is NOT yet a reminder-1 candidate",
      wronglyFound,
      PASS: !wronglyFound,
    });
    await cleanup(accountId);
  }

  // Test 7: exactly old enough for reminder 1 (170 days, past the 166-day
  // threshold), never reminded — must be a reminder-1 candidate, and must
  // NOT yet be a reminder-2 or deletion candidate.
  {
    const { accountId } = await seedAccount("reminder1-test", 170);
    const r1 = await findAccountsNeedingReminder1(supabase);
    const r2 = await findAccountsNeedingReminder2(supabase);
    const del = await findAccountsPastAbandonmentThreshold(supabase);
    const foundR1 = r1.some((a) => a.id === accountId);
    const wronglyFoundR2 = r2.some((a) => a.id === accountId);
    const wronglyFoundDel = del.some((a) => a.id === accountId);
    results.push({
      test: "a 170-day-old never-reminded account IS a reminder-1 candidate, and nothing further yet",
      foundR1,
      wronglyFoundR2,
      wronglyFoundDel,
      PASS: foundR1 && !wronglyFoundR2 && !wronglyFoundDel,
    });
    await cleanup(accountId);
  }

  // Test 8: exactly old enough for reminder 2 (178 days, past the 177-day
  // threshold), reminder 1 already sent, reminder 2 not sent yet.
  {
    const { accountId } = await seedAccount("reminder2-test", 178, { reminder1DaysAgo: 8 });
    const r2 = await findAccountsNeedingReminder2(supabase);
    const del = await findAccountsPastAbandonmentThreshold(supabase);
    const foundR2 = r2.some((a) => a.id === accountId);
    const wronglyFoundDel = del.some((a) => a.id === accountId);
    results.push({
      test: "a 178-day-old, once-reminded account IS a reminder-2 candidate, and not a deletion candidate yet",
      foundR2,
      wronglyFoundDel,
      PASS: foundR2 && !wronglyFoundDel,
    });
    await cleanup(accountId);
  }

  // Test 9: the missed-run collapse case — 181 days old, reminded twice,
  // but the SECOND reminder only went out 1 day ago (not the full 3-day
  // gap). Must NOT be a deletion candidate yet, mirroring
  // data_retention_ops.js's own missed-run protection.
  {
    const { accountId } = await seedAccount("late-second-reminder-test", 181, { reminder1DaysAgo: 15, reminder2DaysAgo: 1 });
    const del = await findAccountsPastAbandonmentThreshold(supabase);
    const wronglyFound = del.some((a) => a.id === accountId);
    results.push({
      test: "reminded a second time only 1 day ago (181 days old) is NOT yet a deletion candidate — the exact missed-run bug data_retention_ops.js already guards against",
      wronglyFound,
      PASS: !wronglyFound,
    });
    await cleanup(accountId);
  }

  console.log(JSON.stringify(results, null, 2));
  const allPass = results.every((r) => r.PASS);
  console.log(allPass ? "\nALL TESTS PASS" : "\nSOME TESTS FAILED");
  console.log(`\n(constants in effect: ABANDONMENT_DAYS=${ABANDONMENT_DAYS}, REMINDER_1_AT_DAYS=${REMINDER_1_AT_DAYS}, REMINDER_2_AT_DAYS=${REMINDER_2_AT_DAYS})`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run threw:", err);
  process.exit(1);
});
