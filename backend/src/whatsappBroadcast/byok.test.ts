// BYOK is permanent and mandatory (Werner): a broadcast is sent only with the paying customer's OWN Meta credentials. LazyRelay
// holds no shared or platform WhatsApp token. These tests use the REAL plan check (resolveTier / checkWhatsappPlan) against the
// in-memory fake, so "free plan refused" is proven against the same code the rest of the repo uses.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tables, vault } from "../testFakeSupabase.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("./testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});

const { checkSendEligibility } = await import("./byok.js");
const { ACC, SA, TOKEN, WABA, PHONE_ID, seedWorld, resetTables, setTestEnv } = await import("./testKit.js");
const { serializeWhatsAppBundle } = await import("../platforms/whatsapp/credentials.js");

const SAVED = { ...process.env };
function subscription(tier: string, status = "active") {
  tables.subscriptions = [{ account_id: ACC, tier, status }];
}

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
  subscription("business");
});
afterEach(() => {
  process.env = { ...SAVED };
});

describe("checkSendEligibility", () => {
  it("a paid plan with its own stored credentials may send, and gets the customer's own login back", async () => {
    const out = await checkSendEligibility(ACC, SA);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.bundle).toMatchObject({ systemUserToken: TOKEN, wabaId: WABA, phoneNumberId: PHONE_ID });
  });

  it("a free plan is refused (no subscription row counts as free)", async () => {
    tables.subscriptions = [];
    expect(await checkSendEligibility(ACC, SA)).toEqual({ ok: false, reason: "plan" });
  });

  it("a cancelled or lapsed paid plan is refused", async () => {
    subscription("business", "canceled");
    expect(await checkSendEligibility(ACC, SA)).toEqual({ ok: false, reason: "plan" });
  });

  it("a paid plan below the WhatsApp tier (starter, pro) is refused", async () => {
    for (const tier of ["free", "starter", "pro"]) {
      subscription(tier);
      expect(await checkSendEligibility(ACC, SA)).toEqual({ ok: false, reason: "plan" });
    }
  });

  it("a connection with no stored login is refused", async () => {
    tables.social_accounts[0].access_token_vault_id = null;
    expect(await checkSendEligibility(ACC, SA)).toEqual({ ok: false, reason: "no_own_credentials" });
  });

  it("a stored login that is empty, damaged, or not a complete bundle is refused (no fallback)", async () => {
    for (const stored of ["", "not json", JSON.stringify({ v: 1, systemUserToken: "short", wabaId: WABA, phoneNumberId: PHONE_ID }), JSON.stringify({ v: 2 })]) {
      vault.set("vault-wa-1", stored);
      expect(await checkSendEligibility(ACC, SA)).toEqual({ ok: false, reason: "no_own_credentials" });
    }
  });

  it("a connection that is not in credential_mode 'byok' is refused", async () => {
    tables.social_accounts[0].credential_mode = "platform";
    expect(await checkSendEligibility(ACC, SA)).toEqual({ ok: false, reason: "no_own_credentials" });
  });

  it("a stored login whose ids disagree with the connection row is refused", async () => {
    vault.set("vault-wa-1", serializeWhatsAppBundle({ systemUserToken: TOKEN, wabaId: "5555555555", phoneNumberId: PHONE_ID }));
    expect(await checkSendEligibility(ACC, SA)).toEqual({ ok: false, reason: "no_own_credentials" });
  });

  it("another account's connection is not found, even with a valid login", async () => {
    tables.subscriptions.push({ account_id: "acc-other", tier: "business", status: "active" });
    expect(await checkSendEligibility("acc-other", SA)).toEqual({ ok: false, reason: "connection_unavailable" });
  });

  it("an invalid, disconnected, wiped, paused or reconnect-needed connection is unavailable", async () => {
    for (const over of [{ byok_status: "invalid" }, { byok_status: null }, { disconnected_at: "2026-10-01T00:00:00Z" }, { tokens_wiped_at: "2026-10-01T00:00:00Z" }, { paused_at: "2026-10-01T00:00:00Z" }, { needs_reconnect_at: "2026-10-01T00:00:00Z" }]) {
      seedWorld();
      Object.assign(tables.social_accounts[0], over);
      expect(await checkSendEligibility(ACC, SA)).toEqual({ ok: false, reason: "connection_unavailable" });
    }
  });

  it("a paused connection (restriction, quality, credentials) is refused", async () => {
    tables.whatsapp_connection_send_state = [{ social_account_id: SA, account_id: ACC, paused_at: "2026-10-16T00:00:00Z", pause_reason: "quality" }];
    expect(await checkSendEligibility(ACC, SA)).toEqual({ ok: false, reason: "connection_paused" });
  });

  it("an unreadable plan fails closed", async () => {
    Object.defineProperty(tables, "subscriptions", { get() { throw new Error("db down"); }, configurable: true });
    try {
      expect(await checkSendEligibility(ACC, SA)).toEqual({ ok: false, reason: "plan" });
    } finally {
      Object.defineProperty(tables, "subscriptions", { value: [], writable: true, configurable: true, enumerable: true });
    }
  });
});

describe("no platform-level Meta token exists", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sources = [
    ...fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "testKit.ts").map((f) => path.join(dir, f)),
    path.resolve(dir, "../http/routes/whatsappBroadcasts.routes.ts"),
  ].filter((f) => fs.existsSync(f));

  it("the broadcast code reads no token, secret or access key from the environment", () => {
    expect(sources.length).toBeGreaterThan(3);
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      const envReads = [...text.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[\s*([A-Za-z_"'`]+))/g)].map((m) => m[1] ?? m[2]);
      for (const name of envReads) {
        expect(name, `${path.basename(file)} reads ${name}`).not.toMatch(/TOKEN|SECRET|ACCESS|KEY|META|FACEBOOK|GRAPH/i);
      }
    }
  });

  it("sendTemplate and listTemplates take the customer's login as a parameter: there is no variant without one", async () => {
    const api = await import("./cloudApi.js");
    expect(api.sendTemplate.length).toBe(3);
    expect(api.listTemplates.length).toBe(2);
  });

  it("with every Meta-looking environment variable set, the login still comes only from the customer's own stored bundle", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "ENVTOKEN-SHOULD-NEVER-BE-USED-000000";
    process.env.META_ACCESS_TOKEN = "ENVTOKEN-SHOULD-NEVER-BE-USED-111111";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "ENVTOKEN-SHOULD-NEVER-BE-USED-222222";
    const out = await checkSendEligibility(ACC, SA);
    expect(out.ok && out.bundle.systemUserToken).toBe(TOKEN);
    tables.social_accounts[0].access_token_vault_id = null;
    expect(await checkSendEligibility(ACC, SA)).toEqual({ ok: false, reason: "no_own_credentials" });
  });
});
