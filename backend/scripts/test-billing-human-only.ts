// Verification of the requireHumanAuth guard on every billing route that changes anything: checkout, change plan,
// cancel, and the storage, brand and seat add-ons. A customer API key (lzr_live_...) must be refused with 403 on all
// nine, while a human Supabase JWT must get past the guard (any status other than the human-only 403 is fine: with an
// empty body and no Paddle config the routes answer 400, 404 or 503, and nothing ever reaches a payment provider).
// The vitest file src/http/routes/billingHumanOnly.test.ts only checks the middleware is on each route's source line;
// this one proves it over real HTTP. Boots the real app (same pattern as test-checkout-blocks-past-due.ts) with the
// StubMorAdapter, a real throwaway account, a real API key row and a real magic-link session.
//
// Run: npx tsx scripts/test-billing-human-only.ts
import "dotenv/config";
import dotenv from "dotenv";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "../src/supabase.js";
import { StubMorAdapter } from "../src/billing/stub.js";
import { buildApp } from "../src/http/app.js";
import { API_KEY_PREFIX, hashApiKey } from "../src/http/auth.js";
import type { PlatformAdapterRegistry } from "../src/platforms/connect.js";

// The anon key only lives in frontend/.env locally (public, browser-safe); fall back to the backend env var.
const frontendEnv = dotenv.config({ path: new URL("../../frontend/.env", import.meta.url) }).parsed ?? {};
const anon = createClient(process.env.SUPABASE_URL!, frontendEnv.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY!);

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

const FAKE_ID = "00000000-0000-0000-0000-000000000000";
const ROUTES: string[] = [
  "/subscription/checkout",
  "/subscription/change-tier",
  "/subscription/cancel",
  "/storage-addons/checkout",
  `/storage-addons/${FAKE_ID}/cancel`,
  "/brand-addons/checkout",
  `/brand-addons/${FAKE_ID}/cancel`,
  "/seat-addons/checkout",
  `/seat-addons/${FAKE_ID}/cancel`,
];

async function main() {
  const email = `billing-human-only-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  await supabase.from("accounts").upsert({ id: accountId, email });

  const rawKey = `${API_KEY_PREFIX}${randomBytes(24).toString("hex")}`;
  const { error: keyError } = await supabase.from("api_keys").insert({
    account_id: accountId,
    name: "human-only test key",
    key_prefix: rawKey.slice(0, API_KEY_PREFIX.length + 6),
    key_hash: hashApiKey(rawKey),
  });
  if (keyError) throw keyError;

  const app = buildApp(new StubMorAdapter(), new Map() as PlatformAdapterRegistry);
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
    const jwt = sessionData.session.access_token;

    const call = async (route: string, token: string) => {
      const res = await fetch(`${base}/api${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { status: res.status, error: body.error ?? "" };
    };

    for (const route of ROUTES) {
      const viaKey = await call(route, rawKey);
      check(
        `POST ${route.replace(FAKE_ID, ":id")} rejects an API key with 403 (human-only)`,
        viaKey.status === 403 && /not an API key/i.test(viaKey.error),
        `HTTP ${viaKey.status} ${viaKey.error}`,
      );
      const viaJwt = await call(route, jwt);
      check(
        `POST ${route.replace(FAKE_ID, ":id")} lets a human JWT past the guard`,
        !(viaJwt.status === 403 && /not an API key/i.test(viaJwt.error)) && viaJwt.status !== 401,
        `HTTP ${viaJwt.status} ${viaJwt.error}`,
      );
    }

    const readViaKey = await fetch(`${base}/api/subscription`, { headers: { Authorization: `Bearer ${rawKey}` } });
    check("GET /subscription (read-only) stays open to an API key", readViaKey.status === 200, `HTTP ${readViaKey.status}`);
  } finally {
    server.close();
    await supabase.from("api_keys").delete().eq("account_id", accountId);
    await supabase.auth.admin.deleteUser(accountId);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
