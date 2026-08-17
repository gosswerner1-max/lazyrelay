// Real test of seat add-ons (Agency pricing pass, 2026-08-17): the webhook
// sync path, capacity math, the MAX_SEAT_ADDONS_PER_ACCOUNT=2 cap enforced
// at checkout, and the cancel-cascade -- mirrors test-cancel-cascades-addons.ts
// (direct syncSubscriptionFromWebhook/cancelSubscription calls, bypassing
// real Paddle) for the sync/cascade parts, and test-team-invite.ts's
// boot-the-real-app pattern for the one check that only exists at the HTTP
// layer (the checkout route's own cap rejection).
//
// Run: npx tsx src/test-seat-addon-cascade.ts
import "dotenv/config";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";
import { syncSubscriptionFromWebhook, cancelSubscription } from "./billing/sync.js";
import { StubMorAdapter } from "./billing/stub.js";
import { getSeatCapacity, MAX_SEAT_ADDONS_PER_ACCOUNT } from "./seatLimits.js";
import { buildApp } from "./http/app.js";
import type { SeatAddonEvent } from "./billing/types.js";
import type { PlatformAdapterRegistry } from "./platforms/connect.js";

// Same reasoning as test-team-invite.ts: the anon key only lives in
// frontend/.env, needed here to turn a magic link into a real bearer token.
const frontendEnv = dotenv.config({ path: new URL("../../frontend/.env", import.meta.url) }).parsed ?? {};
const anon = createClient(process.env.SUPABASE_URL!, frontendEnv.VITE_SUPABASE_ANON_KEY!);

const morAdapter = new StubMorAdapter();

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
  const email = `seat-addon-cascade-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  // enterprise (Business) = 2 included seats, per SEAT_LIMITS.
  await supabase.from("subscriptions").upsert(
    {
      account_id: accountId,
      mor_subscription_id: `sub_tier_seat_cascade_${Date.now()}`,
      tier: "enterprise",
      status: "active",
      current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );

  const capacityBefore = await getSeatCapacity(accountId);
  check("baseline capacity is 2 (Business, no add-ons yet)", capacityBefore.totalLimit === 2, JSON.stringify(capacityBefore));

  // Simulate a successful Paddle webhook for a seat add-on -- bypasses real
  // Paddle entirely, same pattern test-cancel-cascades-addons.ts uses.
  const addonEvent: SeatAddonEvent = {
    kind: "seat_addon",
    morSubscriptionId: `sub_seat_addon_cascade_${Date.now()}`,
    accountEmail: email,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  };
  await syncSubscriptionFromWebhook(addonEvent);

  const capacityAfter = await getSeatCapacity(accountId);
  check(
    "capacity increases to 3 after one active seat add-on",
    capacityAfter.totalLimit === 3 && capacityAfter.addonSlots === 1,
    JSON.stringify(capacityAfter)
  );

  // Add a second add-on and confirm the checkout route's own cap check
  // (MAX_SEAT_ADDONS_PER_ACCOUNT=2) rejects a 3rd -- this enforcement lives
  // in routes.ts, not seatLimits.ts, so it can only be tested over real HTTP.
  const secondAddonEvent: SeatAddonEvent = {
    kind: "seat_addon",
    morSubscriptionId: `sub_seat_addon_cascade_2_${Date.now()}`,
    accountEmail: email,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  };
  await syncSubscriptionFromWebhook(secondAddonEvent);

  const app = buildApp(morAdapter, new Map() as PlatformAdapterRegistry);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: "https://lazyrelay.com" },
  });
  if (linkError || !linkData) throw linkError ?? new Error("no link returned");
  const { data: sessionData, error: otpError } = await anon.auth.verifyOtp({
    type: "magiclink",
    token_hash: linkData.properties.hashed_token,
  });
  if (otpError || !sessionData.session) throw otpError ?? new Error("no session returned");

  // 2 active seat add-ons already exist (MAX_SEAT_ADDONS_PER_ACCOUNT) -- the
  // route's cap check runs BEFORE the Paddle price/apiKey lookup, so this
  // proves the cap fires even with no real Paddle configured in this
  // environment (the actual current deployed state).
  const checkoutRes = await fetch(`${base}/api/seat-addons/checkout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionData.session.access_token}` },
  });
  const checkoutBody = await checkoutRes.json();
  check(
    `checkout route rejects a 3rd seat add-on once ${MAX_SEAT_ADDONS_PER_ACCOUNT} are already active`,
    checkoutRes.status === 403 && new RegExp(`already have ${MAX_SEAT_ADDONS_PER_ACCOUNT} seat add-ons`, "i").test(checkoutBody.error ?? ""),
    `HTTP ${checkoutRes.status} ${JSON.stringify(checkoutBody)}`
  );
  server.close();

  const result = await cancelSubscription(accountId, morAdapter, undefined, true);
  check("cancelSubscription succeeds against the stub MoR adapter", result.success, JSON.stringify(result));

  const { data: seatAddonRows } = await supabase
    .from("seat_addons")
    .select("cancel_at_period_end")
    .eq("account_id", accountId);
  check(
    "cancelling the main plan cascaded to cancel_at_period_end on both seat add-ons",
    (seatAddonRows ?? []).length === 2 && (seatAddonRows ?? []).every((r) => r.cancel_at_period_end === true),
    JSON.stringify(seatAddonRows)
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  await supabase.auth.admin.deleteUser(accountId);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
