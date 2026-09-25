// SECURITY FIX (2026-09-25) verification: POST /subscription/checkout's
// duplicate-subscription guard used to only check for active/trialing,
// missing past_due entirely -- a past_due account could open a second,
// independent Paddle checkout while the first subscription was still
// nominally alive, whose webhook would then silently overwrite the tracked
// mor_subscription_id (upsert keyed on account_id) and orphan the first
// subscription. This proves the route itself now rejects the attempt before
// ever calling buildCheckoutTransaction -- boots the real app (same pattern
// as test-seat-addon-cascade.ts) with the StubMorAdapter, real HTTP request,
// no real Paddle call anywhere (buildCheckoutTransaction is never reached).
//
// Run: npx tsx src/test-checkout-blocks-past-due.ts
import "dotenv/config";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";
import { StubMorAdapter } from "./billing/stub.js";
import { buildApp } from "./http/app.js";
import type { PlatformAdapterRegistry } from "./platforms/connect.js";

const frontendEnv = dotenv.config({ path: new URL("../../frontend/.env", import.meta.url) }).parsed ?? {};
const anon = createClient(process.env.SUPABASE_URL!, frontendEnv.VITE_SUPABASE_ANON_KEY!);

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
  const morAdapter = new StubMorAdapter();
  const email = `checkout-past-due-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  const originalMorSubscriptionId = `sub_past_due_${Date.now()}`;
  await supabase.from("subscriptions").upsert(
    {
      account_id: accountId,
      mor_subscription_id: originalMorSubscriptionId,
      tier: "business",
      status: "past_due",
      current_period_end: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );

  const app = buildApp(morAdapter, new Map() as PlatformAdapterRegistry);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  try {
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

    const checkoutRes = await fetch(`${base}/api/subscription/checkout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionData.session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tier: "enterprise" }),
    });
    const checkoutBody = await checkoutRes.json();
    check(
      "checkout is rejected (400) for a past_due account instead of opening a second Paddle subscription",
      checkoutRes.status === 400 && /past due/i.test(checkoutBody.error ?? ""),
      `HTTP ${checkoutRes.status} ${JSON.stringify(checkoutBody)}`,
    );

    const { data: subAfter } = await supabase.from("subscriptions").select("mor_subscription_id, status").eq("account_id", accountId).single();
    check(
      "the original past_due subscription row is untouched -- no second subscription was ever created or upserted over it",
      subAfter?.mor_subscription_id === originalMorSubscriptionId && subAfter?.status === "past_due",
      JSON.stringify(subAfter),
    );
  } finally {
    server.close();
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
