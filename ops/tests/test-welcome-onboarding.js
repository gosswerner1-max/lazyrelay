// Live, real-database verification for welcome_onboarding_ops.js
// (2026-08-21) -- same discipline as test-data-retention.js: seeds real
// throwaway accounts via the Supabase admin API, runs the real functions,
// checks real results, cleans up after itself. Run directly:
//   node ops/tests/test-welcome-onboarding.js
//
// Uses @example.com addresses deliberately, NOT @lazyrelay.invalid --
// isInternalTestAccount() excludes that domain, which would make the
// find-functions skip these accounts and defeat the point of testing them.
// resend is passed as null throughout -- these tests verify the
// find/mark logic, not actual email delivery (Resend itself is a plain SDK
// call already exercised by the deploy-live data-retention reminder).

const { getSupabaseClient } = require("../shared/supabaseClient.js");
const {
  findAccountsNeedingWelcome,
  sendWelcomeEmail,
  findAccountsNeedingOnboardingNudge,
  sendOnboardingNudgeEmail,
} = require("../accounts/welcome_onboarding_ops.js");

const supabase = getSupabaseClient();

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

async function seedAccount(emailPrefix, createdDaysAgo) {
  const email = `${emailPrefix}-${Date.now()}@example.com`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user created");
  const accountId = user.user.id;

  // DB trigger auto-creates the accounts row (welcome_email_sent_at /
  // onboarding_nudge_sent_at both null by default) -- backdate created_at
  // only, same pattern as test-data-retention.js backdating cancelled_at.
  const { error: updateError } = await supabase
    .from("accounts")
    .update({ created_at: daysAgo(createdDaysAgo) })
    .eq("id", accountId);
  if (updateError) throw updateError;
  return { accountId, email };
}

async function cleanup(accountId) {
  await supabase.auth.admin.deleteUser(accountId);
}

async function main() {
  const results = [];

  // Test 1: brand-new account (created today) -- should be a welcome
  // candidate, should NOT be an onboarding-nudge candidate yet (too recent).
  {
    const { accountId, email } = await seedAccount("welcome-test", 0);
    const welcomeCandidates = await findAccountsNeedingWelcome(supabase);
    const nudgeCandidates = await findAccountsNeedingOnboardingNudge(supabase);
    const foundForWelcome = welcomeCandidates.some((a) => a.id === accountId);
    const wronglyFoundForNudge = nudgeCandidates.some((a) => a.id === accountId);

    await sendWelcomeEmail(supabase, null, null, { id: accountId, email });
    const { data: acctRow } = await supabase.from("accounts").select("welcome_email_sent_at").eq("id", accountId).single();

    results.push({
      test: "brand-new account is a welcome candidate, not yet a nudge candidate",
      foundForWelcome,
      wronglyFoundForNudge,
      welcomeEmailSentAtSet: !!acctRow?.welcome_email_sent_at,
      PASS: foundForWelcome && !wronglyFoundForNudge && !!acctRow?.welcome_email_sent_at,
    });
    await cleanup(accountId);
  }

  // Test 2: account created 4 days ago (past the 3-day threshold), zero
  // connected accounts -- should be an onboarding-nudge candidate.
  {
    const { accountId, email } = await seedAccount("nudge-test", 4);
    const nudgeCandidates = await findAccountsNeedingOnboardingNudge(supabase);
    const foundForNudge = nudgeCandidates.some((a) => a.id === accountId);

    await sendOnboardingNudgeEmail(supabase, null, null, { id: accountId, email });
    const { data: acctRow } = await supabase.from("accounts").select("onboarding_nudge_sent_at").eq("id", accountId).single();

    const nudgeCandidatesAfter = await findAccountsNeedingOnboardingNudge(supabase);
    const stillFoundAfterSend = nudgeCandidatesAfter.some((a) => a.id === accountId);

    results.push({
      test: "4-day-old zero-account signup is a nudge candidate, and sending marks it done",
      foundForNudge,
      nudgeSentAtSet: !!acctRow?.onboarding_nudge_sent_at,
      stillFoundAfterSend,
      PASS: foundForNudge && !!acctRow?.onboarding_nudge_sent_at && !stillFoundAfterSend,
    });
    await cleanup(accountId);
  }

  // Test 3: account created 4 days ago but WITH a connected social
  // account -- should NOT be a nudge candidate. access_token_vault_id is a
  // real not-null FK into vault.secrets (migration 0001) -- store_social_token
  // is the real RPC the product itself uses (backend/src/security-test.ts),
  // not a raw insert, since vault.secrets can't be written to directly.
  {
    const { accountId } = await seedAccount("connected-test", 4);
    const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", {
      p_token: `test-token-${Date.now()}`,
    });
    if (vaultError) throw vaultError;
    const { error: socialError } = await supabase.from("social_accounts").insert({
      account_id: accountId,
      platform: "meta",
      platform_account_id: `test-${Date.now()}`,
      display_name: "Test Account",
      access_token_vault_id: vaultId,
    });
    if (socialError) throw socialError;
    const nudgeCandidates = await findAccountsNeedingOnboardingNudge(supabase);
    const wronglyFoundForNudge = nudgeCandidates.some((a) => a.id === accountId);
    results.push({
      test: "4-day-old signup WITH a connected account is NOT a nudge candidate",
      wronglyFoundForNudge,
      PASS: !wronglyFoundForNudge,
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
