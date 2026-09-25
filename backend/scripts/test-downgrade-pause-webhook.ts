// SECURITY FIX (2026-09-25) verification: ops/accounts/accounts_ops.js's
// planDowngradePause/enforceDowngradePause were real, tested (see
// ops/accounts/test-downgrade-pause.js) but had zero callers on any real
// code path -- a downgrade landing via the actual Paddle webhook
// (syncSubscriptionFromWebhook) never paused anything over the new tier's
// lower connected-account limit. This proves the fix at the real call site:
// a webhook event carrying a lower tier now pauses the newest-connected
// accounts down to the new limit, and a later webhook carrying a higher
// tier correctly unpauses them again -- both directions, no HTTP layer
// involved, no real Paddle call anywhere (this event never reaches Paddle
// at all; it's exactly the shape syncSubscriptionFromWebhook already
// accepts from a verified webhook).
//
// ACCOUNT_LIMITS is monkey-patched down to small numbers for the duration
// of this process only (restored before exit) so the test doesn't need to
// create 30-50 real social_accounts rows to see the pause/unpause boundary.
//
// Run: npx tsx scripts/test-downgrade-pause-webhook.ts
import "dotenv/config";
import { supabase } from "../src/supabase.js";
import { syncSubscriptionFromWebhook } from "../src/billing/sync.js";
import { ACCOUNT_LIMITS } from "../src/accountLimits.js";
import type { SubscriptionEvent } from "../src/billing/types.js";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}${detail ? `\n        -> ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `\n        -> ${detail}` : ""}`);
  }
}

async function main() {
  // Restored in the finally block below -- these are the real exported
  // constants other code in this same process (sync.ts) reads from, so the
  // patch must not outlive this script.
  const originalEnterprise = ACCOUNT_LIMITS.enterprise;
  const originalBusiness = ACCOUNT_LIMITS.business;
  (ACCOUNT_LIMITS as Record<string, number>).enterprise = 5;
  (ACCOUNT_LIMITS as Record<string, number>).business = 2;

  const email = `downgrade-webhook-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  try {
    const socialAccountIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { data: vaultId } = await supabase.rpc("store_social_token", { p_token: `tok-downgrade-${i}` });
      const { data: sa, error: saError } = await supabase
        .from("social_accounts")
        .insert({
          account_id: accountId,
          platform: "meta",
          platform_account_id: `downgrade-page-${i}-${Date.now()}`,
          display_name: `Downgrade Test Page ${i}`,
          access_token_vault_id: vaultId,
        })
        .select("id")
        .single();
      if (saError || !sa) throw saError ?? new Error("no social_account returned");
      socialAccountIds.push(sa.id);
      await new Promise((r) => setTimeout(r, 20)); // distinct connected_at ordering, oldest-first
    }
    console.log(`Connected 5 test social accounts, oldest-first: ${socialAccountIds.join(", ")}`);

    // First webhook: account's genuine first-ever tier event, already on the
    // (patched) enterprise limit of 5 -- exactly at capacity, nothing to pause.
    const morSubscriptionId = `sub_downgrade_webhook_${Date.now()}`;
    const firstEvent: SubscriptionEvent = {
      kind: "tier",
      morSubscriptionId,
      accountEmail: email,
      accountId,
      tier: "enterprise",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      cancelAtPeriodEnd: false,
    };
    await syncSubscriptionFromWebhook(firstEvent);

    const { data: afterFirst } = await supabase.from("social_accounts").select("id, paused_at").in("id", socialAccountIds);
    check(
      "at capacity (5 accounts, patched enterprise limit 5) -- nothing paused yet",
      (afterFirst ?? []).every((a) => a.paused_at === null),
      JSON.stringify(afterFirst),
    );

    // Downgrade webhook: same subscription, tier moves to business (patched
    // limit 2) -- this is the exact webhook shape /subscription/change-tier
    // produces for a real downgrade. Expect the 3 NEWEST connections paused,
    // the 2 oldest left active.
    const downgradeEvent: SubscriptionEvent = {
      ...firstEvent,
      tier: "business",
      occurredAt: new Date().toISOString(), // strictly newer than firstEvent
    };
    await syncSubscriptionFromWebhook(downgradeEvent);

    const { data: afterDowngrade } = await supabase
      .from("social_accounts")
      .select("id, paused_at")
      .in("id", socialAccountIds)
      .order("id");
    const pausedAfterDowngrade = new Set((afterDowngrade ?? []).filter((a) => a.paused_at !== null).map((a) => a.id));
    const expectedPaused = new Set(socialAccountIds.slice(2)); // newest 3
    check(
      "downgrade webhook (enterprise->business, patched limits 5->2) pauses exactly the newest 3, keeps the oldest 2 active",
      pausedAfterDowngrade.size === 3 &&
        [...expectedPaused].every((id) => pausedAfterDowngrade.has(id)) &&
        socialAccountIds.slice(0, 2).every((id) => !pausedAfterDowngrade.has(id)),
      JSON.stringify(afterDowngrade),
    );

    // Upgrade back: tier moves back to enterprise (patched limit 5) -- expect
    // all 3 previously-paused accounts unpaused again.
    const upgradeEvent: SubscriptionEvent = {
      ...firstEvent,
      tier: "enterprise",
      occurredAt: new Date(Date.now() + 1000).toISOString(), // strictly newer than downgradeEvent
    };
    await syncSubscriptionFromWebhook(upgradeEvent);

    const { data: afterUpgrade } = await supabase.from("social_accounts").select("id, paused_at").in("id", socialAccountIds);
    check(
      "upgrade webhook back to enterprise (patched limit 5) unpauses all 5 again",
      (afterUpgrade ?? []).every((a) => a.paused_at === null),
      JSON.stringify(afterUpgrade),
    );

    await supabase.from("social_accounts").delete().in("id", socialAccountIds);
  } finally {
    (ACCOUNT_LIMITS as Record<string, number>).enterprise = originalEnterprise;
    (ACCOUNT_LIMITS as Record<string, number>).business = originalBusiness;
    await supabase.from("subscriptions").delete().eq("account_id", accountId);
    await supabase.auth.admin.deleteUser(accountId);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
