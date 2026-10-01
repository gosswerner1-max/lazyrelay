// Nostr through the REAL connect flow and the REAL routes (connect.ts, socialAccounts.routes.ts): the connection secrets
// go to Vault and nowhere else, the browser only ever gets "connected", and the platform stays dormant (hidden from
// /platforms, refused by the connect route) until its release switch is on. supabase, Vault, relays and the signer are
// in-memory fakes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateSecretKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { tables, vault } from "../testFakeSupabase.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const client = { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => f.fakeRpc(fn, args) };
  return { supabase: client };
});
vi.mock("../accountLimits.js", () => ({ checkNewDistinctAccountLimit: vi.fn(async () => null), checkAccountLimit: vi.fn(async () => null) }));
vi.mock("../http/metaWebhook.js", () => ({ subscribePageToMessaging: vi.fn(async () => {}) }));
vi.mock("../urlSafety.js", () => ({ isSafeMediaUrl: async () => ({ safe: true, addresses: ["93.184.216.34"] }) }));
vi.mock("../scheduler.js", () => ({ getAccessToken: async () => "t" }));
vi.mock("../http/auth.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.accountId = "acc1";
      req.db = { from: (t: string) => f.makeBuilder(t) };
      next();
    },
  };
});
vi.mock("../http/rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n(), publicRateLimit: (_r: any, _s: any, n: any) => n() }));

const { buildSocialAccountsRouter } = await import("../http/routes/socialAccounts.routes.js");
const { NostrAdapter } = await import("./nostr.js");
const { FakeNetwork, FakeSigner } = await import("./nostrTestKit.js");
const { PRIVATE_KEY_REFUSED_MESSAGE } = await import("./nostrSigner.js");
const { validatePostFields } = await import("../postCreation.js");

const SIGNER_RELAY = "wss://signer-relay.example.org";
const SECRET = "connect-secret-5521";

function build(registryEntries: string[] = ["nostr"]) {
  const net = new FakeNetwork();
  const signer = new FakeSigner(net);
  signer.expectSecret = SECRET;
  net.add(SIGNER_RELAY);
  for (const u of ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"]) net.add(u);
  const adapter = new NostrAdapter("https://app.example.org/connect/nostr", { connector: net.connector, timeouts: { connectApprovalMs: 600, signMs: 400, publishMs: 400, readMs: 400 } });
  const registry = new Map<string, unknown>(registryEntries.map((e) => [e, e === "nostr" ? adapter : {}]));
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(buildSocialAccountsRouter(registry as never));
  return { app, net, signer };
}

const future = () => new Date(Date.now() + 10 * 60_000).toISOString();
function seedState(id = "st1") {
  tables.oauth_states = [{ id, account_id: "acc1", platform: "nostr", expires_at: future(), pkce_verifier: null, pending_options: null, pending_token_vault_id: null }];
}
const names = (body: unknown) => (body as Array<{ platform: string }>).map((p) => p.platform);

let logs: string[];
beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  tables.social_accounts = [];
  logs = [];
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NOSTR_PLATFORM_PUBLIC", "NOSTR_TEST_ACCOUNT_IDS", "ARTICLE_PLATFORMS_PUBLIC", "ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS", "SLACK_PLATFORM_PUBLIC", "SLACK_TEST_ACCOUNT_IDS"]) delete process.env[k];
});

describe("connecting Nostr end to end", () => {
  it("saves the connection in Vault only, and the browser gets nothing but connected + an id", async () => {
    const { app, signer } = build();
    seedState();
    const link = signer.bunkerUrl([SIGNER_RELAY], SECRET);
    const r = await request(app).post("/social-accounts/callback").set("Cookie", "lr_oauth_state=st1").send({ code: JSON.stringify({ bunkerUrl: link }), state: "st1" });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ connected: true, socialAccountId: expect.any(String) });
    const everythingTheBrowserSaw = JSON.stringify([r.body, r.headers]);
    for (const secret of [SECRET, link, signer.userSkHex]) expect(everythingTheBrowserSaw).not.toContain(secret);

    // The account row carries only public facts and a pointer into Vault.
    expect(tables.social_accounts).toHaveLength(1);
    const row = tables.social_accounts[0];
    expect(row).toMatchObject({ platform: "nostr", platform_account_id: signer.userPk });
    expect(String(row.display_name)).toMatch(/^npub1[a-z0-9]{4}\.\.\.[a-z0-9]{4}$/);
    expect(row.refresh_token_vault_id).toBeNull();
    expect(row.token_expires_at).toBeNull();
    expect(JSON.stringify(tables)).not.toContain(SECRET);
    expect(JSON.stringify(tables)).not.toContain(signer.userSkHex);

    // The secrets are in Vault: the disposable client key and the bunker secret, never the customer's key.
    const stored = [...vault.values()].join("\n");
    expect(stored).toContain(SECRET);
    expect(stored).toContain('"clientSecretKey"');
    expect(stored).not.toContain(signer.userSkHex);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("the account list the dashboard reads selects no token and no vault pointer", () => {
    // The in-memory database ignores column lists, so this reads the real query: the columns the route asks for.
    const source = readFileSync(fileURLToPath(new URL("../http/routes/socialAccounts.routes.ts", import.meta.url)), "utf8");
    const list = /router\.get\("\/social-accounts", requireAuth[\s\S]*?\.select\("([^"]+)"\)/.exec(source);
    expect(list?.[1]).toContain("display_name");
    expect(list?.[1]).not.toMatch(/token|vault|secret/i);
  });

  it("reconnecting the same Nostr identity updates the one account instead of adding another", async () => {
    const { app, signer } = build();
    for (let i = 0; i < 2; i++) {
      seedState(`st${i}`);
      const r = await request(app).post("/social-accounts/callback").set("Cookie", `lr_oauth_state=st${i}`).send({ code: JSON.stringify({ bunkerUrl: signer.bunkerUrl([SIGNER_RELAY], SECRET) }), state: `st${i}` });
      expect(r.body.connected).toBe(true);
    }
    expect(tables.social_accounts).toHaveLength(1);
  });

  it("an nsec pasted into the connect form is refused with the plain message, saves nothing and contacts nothing", async () => {
    const { app, net } = build();
    seedState();
    const nsec = nip19.nsecEncode(generateSecretKey());
    const r = await request(app).post("/social-accounts/callback").set("Cookie", "lr_oauth_state=st1").send({ code: JSON.stringify({ bunkerUrl: nsec }), state: "st1" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: PRIVATE_KEY_REFUSED_MESSAGE });
    expect(JSON.stringify([r.body, r.text, r.headers])).not.toContain(nsec);
    expect(tables.social_accounts).toHaveLength(0);
    expect(vault.size).toBe(0);
    expect(net.connectLog).toEqual([]);
    expect(logs.join("\n")).not.toContain(nsec);
  });
});

describe("Nostr is dormant until it is switched on", () => {
  it("is not listed when it is not configured at all, and the connect route refuses it", async () => {
    const { app } = build([]);
    expect(names((await request(app).get("/platforms")).body)).not.toContain("nostr");
    const c = await request(app).get("/social-accounts/connect?platform=nostr");
    expect(c.status).toBe(400);
    expect(c.body.error).toMatch(/isn't available to connect yet/);
  });

  it("is still hidden and refused when configured but not switched on", async () => {
    const { app } = build(["nostr", "tiktok"]);
    const r = await request(app).get("/platforms");
    expect(names(r.body)).not.toContain("nostr");
    expect(names(r.body)).toContain("tiktok"); // everything else is unchanged
    const c = await request(app).get("/social-accounts/connect?platform=nostr");
    expect(c.status).toBe(400);
    expect(c.body.error).toMatch(/isn't available to connect yet/);
  });

  it("the article-platform and Slack switches do not open it", async () => {
    process.env.ARTICLE_PLATFORMS_PUBLIC = "true";
    process.env.ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS = "acc1";
    process.env.SLACK_PLATFORM_PUBLIC = "true";
    process.env.SLACK_TEST_ACCOUNT_IDS = "acc1";
    const { app } = build(["nostr", "devto", "slack"]);
    const r = await request(app).get("/platforms");
    expect(names(r.body)).toContain("devto");
    expect(names(r.body)).toContain("slack");
    expect(names(r.body)).not.toContain("nostr");
    expect((await request(app).get("/social-accounts/connect?platform=nostr")).status).toBe(400);
  });

  it("a named test account sees it once configured, others do not, and it never appears without the adapter", async () => {
    const { app } = build(["nostr"]);
    process.env.NOSTR_TEST_ACCOUNT_IDS = "someone-else";
    expect(names((await request(app).get("/platforms")).body)).not.toContain("nostr");
    process.env.NOSTR_TEST_ACCOUNT_IDS = "x, acc1";
    const r = await request(app).get("/platforms");
    expect(names(r.body)).toContain("nostr");
    expect((r.body as Array<{ platform: string; configured: boolean }>).find((p) => p.platform === "nostr")?.configured).toBe(true);
    expect(names((await request(build([]).app).get("/platforms")).body)).not.toContain("nostr");
  });

  it("NOSTR_PLATFORM_PUBLIC opens it to everyone, but only when configured", async () => {
    process.env.NOSTR_PLATFORM_PUBLIC = "true";
    expect(names((await request(build(["nostr"]).app).get("/platforms")).body)).toContain("nostr");
    expect(names((await request(build([]).app).get("/platforms")).body)).not.toContain("nostr");
  });

  it("is in the rules lookup as text only", async () => {
    const r = await request(build([]).app).get("/platforms/rules?platform=nostr");
    expect(r.status).toBe(200);
    expect(r.body.platforms[0]).toMatchObject({ platform: "nostr", text: { maxLength: 4000 }, media: { textOnlyAllowed: true, image: { supported: false }, video: { supported: false } } });
  });
});

describe("scheduling a Nostr post", () => {
  const tomorrow = () => new Date(Date.now() + 24 * 3600_000).toISOString();
  const seed = () => (tables.social_accounts = [{ id: "sa1", account_id: "acc1", platform: "nostr" }]);

  it("refuses text over the 4,000 character cap (or the byte cap) up front, with plain words", async () => {
    seed();
    for (const content of ["x".repeat(4001), "\u{1F600}".repeat(2100)]) {
      const r = await validatePostFields("acc1", { socialAccountId: "sa1", content, scheduledFor: tomorrow() });
      expect(r).toMatchObject({ status: 400, body: { error: "Nostr posts can be up to 4,000 characters of plain text" } });
    }
  });

  it("accepts text exactly at the cap", async () => {
    seed();
    const r = await validatePostFields("acc1", { socialAccountId: "sa1", content: "x".repeat(4000), scheduledFor: tomorrow() });
    expect("status" in r).toBe(false);
  });
});
