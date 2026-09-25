// SECURITY FIX (2026-09-25) verification: voluntary cancellation
// (cancelSubscription in billing/sync.ts) already cascades to every active
// storage/brand/seat add-on, but the chargeback-driven forced-revocation
// path (recordRefund) used to only revoke the main subscription, leaving
// every add-on active and still billing. This proves the fix: a chargeback
// refund event now triggers revokeSubscriptionImmediately for the main
// subscription AND every active storage/brand/seat add-on on that account.
//
// Uses a StubMorAdapter subclass that records every
// revokeSubscriptionImmediately call instead of the real Paddle SDK -- no
// real Paddle API call is made anywhere in this script.
//
// Run: npx tsx scripts/test-chargeback-cascades-addons.ts
import "dotenv/config";
import { supabase } from "../src/supabase.js";
import { syncSubscriptionFromWebhook, recordBillingEvent } from "../src/billing/sync.js";
import { StubMorAdapter } from "../src/billing/stub.js";
import type { CancelResult } from "../src/billing/types.js";
import type { StorageAddonEvent, BrandAddonEvent, SeatAddonEvent, SaleRecordEvent, RefundRecordEvent } from "../src/billing/types.js";

class RecordingMorAdapter extends StubMorAdapter {
  revokedIds: string[] = [];
  async revokeSubscriptionImmediately(morSubscriptionId: string): Promise<CancelResult> {
    this.revokedIds.push(morSubscriptionId);
    return { success: true, errorMessage: null };
  }
}

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
  const morAdapter = new RecordingMorAdapter();
  const email = `chargeback-cascade-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  const mainSubId = `sub_tier_chargeback_${Date.now()}`;
  await supabase.from("subscriptions").upsert(
    {
      account_id: accountId,
      mor_subscription_id: mainSubId,
      tier: "enterprise",
      status: "active",
      current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );

  const storageAddonId = `sub_storage_chargeback_${Date.now()}`;
  const brandAddonId = `sub_brand_chargeback_${Date.now()}`;
  const seatAddonId = `sub_seat_chargeback_${Date.now()}`;

  const storageEvent: StorageAddonEvent = {
    kind: "storage_addon",
    morSubscriptionId: storageAddonId,
    accountEmail: email,
    gbAmount: 5,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    occurredAt: new Date().toISOString(),
    cancelAtPeriodEnd: false,
  };
  const brandEvent: BrandAddonEvent = {
    kind: "brand_addon",
    morSubscriptionId: brandAddonId,
    accountEmail: email,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    occurredAt: new Date().toISOString(),
    cancelAtPeriodEnd: false,
  };
  const seatEvent: SeatAddonEvent = {
    kind: "seat_addon",
    morSubscriptionId: seatAddonId,
    accountEmail: email,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    occurredAt: new Date().toISOString(),
    cancelAtPeriodEnd: false,
  };
  await syncSubscriptionFromWebhook(storageEvent);
  await syncSubscriptionFromWebhook(brandEvent);
  await syncSubscriptionFromWebhook(seatEvent);

  const { data: beforeStorage } = await supabase.from("storage_addons").select("status").eq("mor_subscription_id", storageAddonId).single();
  const { data: beforeBrand } = await supabase.from("brand_addons").select("status").eq("mor_subscription_id", brandAddonId).single();
  const { data: beforeSeat } = await supabase.from("seat_addons").select("status").eq("mor_subscription_id", seatAddonId).single();
  check(
    "setup: all three add-ons are active before the chargeback",
    beforeStorage?.status === "active" && beforeBrand?.status === "active" && beforeSeat?.status === "active",
    JSON.stringify({ beforeStorage, beforeBrand, beforeSeat }),
  );

  // recordRefund resolves the account via the linked sale record, not from
  // the refund payload itself (Paddle's adjustment payload carries no
  // email) -- so a real sale record must exist first, same as production.
  const paddleTransactionId = `txn_chargeback_${Date.now()}`;
  const saleEvent: SaleRecordEvent = {
    kind: "sale_record",
    accountEmail: email,
    accountId,
    paddleTransactionId,
    paddleSubscriptionId: mainSubId,
    invoiceNumber: null,
    currencyCode: "USD",
    subtotal: "49.00",
    tax: "0.00",
    total: "49.00",
    grandTotal: "49.00",
    payoutCurrencyCode: null,
    payoutSubtotal: null,
    payoutTax: null,
    payoutFee: null,
    payoutEarnings: null,
    occurredAt: new Date().toISOString(),
  };
  await recordBillingEvent(saleEvent, morAdapter);

  const refundEvent: RefundRecordEvent = {
    kind: "refund_record",
    paddleAdjustmentId: `adj_chargeback_${Date.now()}`,
    paddleTransactionId,
    paddleSubscriptionId: mainSubId,
    reason: "chargeback: bank dispute",
    currencyCode: "USD",
    subtotal: "49.00",
    tax: "0.00",
    total: "49.00",
    occurredAt: new Date().toISOString(),
  };
  await recordBillingEvent(refundEvent, morAdapter);

  check(
    "chargeback revoked the main subscription immediately",
    morAdapter.revokedIds.includes(mainSubId),
    JSON.stringify(morAdapter.revokedIds),
  );
  check(
    "chargeback cascaded to revoke the storage add-on immediately",
    morAdapter.revokedIds.includes(storageAddonId),
    JSON.stringify(morAdapter.revokedIds),
  );
  check(
    "chargeback cascaded to revoke the brand add-on immediately",
    morAdapter.revokedIds.includes(brandAddonId),
    JSON.stringify(morAdapter.revokedIds),
  );
  check(
    "chargeback cascaded to revoke the seat add-on immediately",
    morAdapter.revokedIds.includes(seatAddonId),
    JSON.stringify(morAdapter.revokedIds),
  );
  check("exactly 4 revocations happened, no more, no fewer", morAdapter.revokedIds.length === 4, JSON.stringify(morAdapter.revokedIds));

  await supabase.from("billing_records").delete().eq("account_id", accountId);
  await supabase.from("storage_addons").delete().eq("account_id", accountId);
  await supabase.from("brand_addons").delete().eq("account_id", accountId);
  await supabase.from("seat_addons").delete().eq("account_id", accountId);
  await supabase.from("subscriptions").delete().eq("account_id", accountId);
  await supabase.auth.admin.deleteUser(accountId);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
