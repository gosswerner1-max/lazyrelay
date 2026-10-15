// GET /whatsapp/webhook-info: sign-in, the feature flag, the plan gate (all six tier codes), the unset-token state, the
// public URL source, per-connection inboundReady (a boolean only), cross-account isolation, no-store, and that no App
// Secret (or token) ever appears in a response or a log line. Supabase is the in-memory fake; nothing real is called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables, vault } from "../../testFakeSupabase.js";

const ctx = vi.hoisted(() => ({ account: "acc1", signedIn: true, rpcVaultIds: [] as string[] }));
vi.mock("../auth.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    requireAuth: (req: any, res: any, next: any) => {
      if (!ctx.signedIn) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      req.accountId = ctx.account;
      // Row level security stand-in: the caller's role only sees rows of its own account.
      req.db = {
        from: (t: string) => {
          const b: any = f.makeBuilder(t);
          const select = b.select;
          b.select = (cols?: string, o?: unknown) => (select(cols, o), b.eq("account_id", ctx.account));
          return b;
        },
      };
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => f.makeBuilder(t),
      rpc: (fn: string, args: Record<string, unknown>) => {
        if (fn === "read_social_token") ctx.rpcVaultIds.push(String(args.p_vault_id));
        return f.fakeRpc(fn, args);
      },
    },
  };
});

const { buildWhatsAppWebhookInfoRouter, DEFAULT_PUBLIC_API_BASE_URL } = await import("./whatsappWebhookInfo.routes.js");
const { serializeWhatsAppBundle } = await import("../../platforms/whatsapp/credentials.js");
const { WHATSAPP_PLAN_MESSAGE } = await import("../../accountLimits.js");
import type { Tier } from "../../tier.js";

const TOKEN = "test_whatsapp_system_user_token_not_real_0123456789";
const SECRET = "AppSecretNotReal0123456789abcdefAB";
const VERIFY = "handshake-token-not-real";
const bundle = (appSecret?: string) => serializeWhatsAppBundle({ systemUserToken: TOKEN, wabaId: "123456789012345", phoneNumberId: "109876543210987", ...(appSecret ? { appSecret } : {}) });
const SA = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`;
const conn = (n: number, account: string, vaultId: string | null, over: Record<string, unknown> = {}) => ({
  id: SA(n), account_id: account, platform: "whatsapp", display_name: `Shop ${n}`, access_token_vault_id: vaultId, disconnected_at: null, ...over,
});
const setTier = (tier: Tier, account = "acc1") => {
  tables.subscriptions = (tables.subscriptions ?? []).filter((r) => r.account_id !== account);
  tables.subscriptions.push({ account_id: account, tier, status: "active" });
};
const app = () => {
  const a = express();
  a.use(buildWhatsAppWebhookInfoRouter());
  return a;
};
const get = () => request(app()).get("/whatsapp/webhook-info");

let logged: unknown[][];
beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  ctx.account = "acc1";
  ctx.signedIn = true;
  ctx.rpcVaultIds = [];
  process.env.WHATSAPP_BYOK_ENABLED = "true";
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY;
  delete process.env.PUBLIC_API_BASE_URL;
  delete process.env.WHATSAPP_INBOUND_TRIAGE_ENABLED;
  setTier("business");
  vault.set("v1", bundle(SECRET));
  vault.set("v2", bundle());
  tables.social_accounts = [conn(1, "acc1", "v1"), conn(2, "acc1", "v2")];
  logged = [];
  for (const m of ["error", "warn", "log"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logged.push(a));
});
afterEach(() => {
  for (const k of ["WHATSAPP_BYOK_ENABLED", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "PUBLIC_API_BASE_URL", "WHATSAPP_INBOUND_TRIAGE_ENABLED"]) delete process.env[k];
  vi.restoreAllMocks();
});

describe("GET /whatsapp/webhook-info", () => {
  it("needs a sign-in and the feature switched on (404 when off); the 404 sets no-store too", async () => {
    ctx.signedIn = false;
    expect((await get()).status).toBe(401);
    ctx.signedIn = true;
    process.env.WHATSAPP_BYOK_ENABLED = "off";
    const off = await get();
    expect(off.status).toBe(404);
    expect(off.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(off.body)).not.toContain(VERIFY);
  });

  const tiers: Array<[Tier, boolean]> = [["free", false], ["starter", false], ["pro", false], ["business", true], ["agency", true], ["agency_plus", true]];
  it.each(tiers)("plan gate: %s allowed=%s", async (tier, allowed) => {
    setTier(tier);
    const r = await get();
    if (allowed) {
      expect(r.status).toBe(200);
    } else {
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(WHATSAPP_PLAN_MESSAGE);
      expect(r.body.requiresPlan).toBe("Business");
      expect(JSON.stringify(r.body)).not.toContain(VERIFY); // a blocked plan never learns the token
    }
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("returns the documented shape: URL, token, per-connection boolean, triage flag", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["connections", "triageEnabled", "verifyToken", "verifyTokenConfigured", "webhookUrl"]);
    expect(r.body.webhookUrl).toBe(`${DEFAULT_PUBLIC_API_BASE_URL}/api/webhooks/whatsapp`);
    expect(r.body.verifyToken).toBe(VERIFY);
    expect(r.body.verifyTokenConfigured).toBe(true);
    expect(r.body.triageEnabled).toBe(false);
    expect(r.body.connections).toEqual([
      { socialAccountId: SA(1), displayName: "Shop 1", inboundReady: true },
      { socialAccountId: SA(2), displayName: "Shop 2", inboundReady: false },
    ]);
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("PUBLIC_API_BASE_URL overrides the default host (trailing slash tolerated); triage mirrors the env flag exactly", async () => {
    process.env.PUBLIC_API_BASE_URL = "https://api.example.test/";
    process.env.WHATSAPP_INBOUND_TRIAGE_ENABLED = "true";
    const r = await get();
    expect(r.body.webhookUrl).toBe("https://api.example.test/api/webhooks/whatsapp");
    expect(r.body.triageEnabled).toBe(true);
    process.env.WHATSAPP_INBOUND_TRIAGE_ENABLED = "yes";
    expect((await get()).body.triageEnabled).toBe(false);
  });

  it("an unset (or blank) verify token gives null and verifyTokenConfigured false", async () => {
    for (const v of [undefined, "", "   "]) {
      if (v === undefined) delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
      else process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = v;
      const r = await get();
      expect(r.status).toBe(200);
      expect(r.body.verifyToken).toBeNull();
      expect(r.body.verifyTokenConfigured).toBe(false);
    }
  });

  it("the App Secret and the token never appear in the response or in any log line", async () => {
    const r = await get();
    const all = JSON.stringify([r.body, r.headers, logged]);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(SECRET.slice(0, 8));
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('"v1"'); // not even the Vault id
  });

  it("a damaged, wiped, missing or failing login is simply not ready", async () => {
    vault.set("v3", "revoked");
    vault.set("v4", JSON.stringify({ v: 1, systemUserToken: TOKEN, wabaId: "123456789012345", phoneNumberId: "109876543210987", appSecret: "short" }));
    tables.social_accounts = [conn(3, "acc1", "v3"), conn(4, "acc1", "v4"), conn(5, "acc1", null), conn(6, "acc1", "no-such")];
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.connections.map((c: { inboundReady: boolean }) => c.inboundReady)).toEqual([false, false, false, false]);
  });

  it("lists only active WhatsApp connections of the caller's account and reads only their Vault entries", async () => {
    vault.set("other", bundle(SECRET));
    tables.social_accounts = [
      conn(1, "acc1", "v1"),
      conn(2, "acc1", "v2", { disconnected_at: "2026-10-01T00:00:00Z" }),
      conn(3, "acc1", "v1", { platform: "x" }),
      conn(4, "acc2", "other"),
    ];
    const mine = await get();
    expect(mine.body.connections.map((c: { socialAccountId: string }) => c.socialAccountId)).toEqual([SA(1)]);
    expect(ctx.rpcVaultIds).toEqual(["v1"]); // acc2's Vault entry was never read for acc1
    ctx.account = "acc2";
    setTier("agency", "acc2");
    ctx.rpcVaultIds = [];
    const theirs = await get();
    expect(theirs.body.connections).toEqual([{ socialAccountId: SA(4), displayName: "Shop 4", inboundReady: true }]);
    expect(JSON.stringify(theirs.body)).not.toContain("Shop 1");
  });
});
