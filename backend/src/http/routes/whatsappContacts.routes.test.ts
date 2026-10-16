// /whatsapp/contacts routes (Phase 1: contacts and consent, no sending). Gate order (flag, flag, visibility, plan), human-only
// writes, explicit column lists (the encrypted number never comes back), cross-account isolation, consent evidence and hash
// chain, suppression (opted-out numbers can never be imported), erase, and that no phone number is logged. Supabase is the
// in-memory fake, keys are throwaway. NOT proven here: database triggers, row level security and column privileges (no SQL
// harness in this repo).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { randomBytes } from "node:crypto";
import { tables } from "../../testFakeSupabase.js";

const ctx = vi.hoisted(() => ({
  account: "acc1",
  members: ["acc1"] as string[],
  signedIn: true,
  method: "jwt" as "jwt" | "apiKey",
  canSee: true,
  planError: null as string | null,
  selects: [] as string[],
}));

vi.mock("../auth.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  const payload = Buffer.from(JSON.stringify({ sub: "33333333-3333-4333-8333-333333333333" })).toString("base64url");
  return {
    requireAuth: (req: any, res: any, next: any) => {
      if (!ctx.signedIn) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      req.accountId = ctx.account;
      req.authMethod = ctx.method;
      req.rawToken = `h.${payload}.s`;
      // Simulates the row level security policy.
      req.db = {
        from: (t: string) => {
          const b: any = f.makeBuilder(t);
          const select = b.select;
          b.select = (cols?: string, o?: unknown) => {
            if (cols) ctx.selects.push(`${t}:${cols}`);
            return select(cols, o), b.in("account_id", ctx.members);
          };
          return b;
        },
      };
      next();
    },
    requireHumanAuth: (req: any, res: any, next: any) => {
      if (req.authMethod === "apiKey") {
        res.status(403).json({ error: "This endpoint requires signing in with your account, not an API key" });
        return;
      }
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n() }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t) } };
});
vi.mock("./socialAccounts.routes.js", () => ({ canSeePlatform: () => ctx.canSee }));
vi.mock("../../accountLimits.js", () => ({ checkWhatsappPlan: async () => ctx.planError }));

const { buildWhatsAppContactsRouter, whatsappContactsImportJsonParser, WHATSAPP_CONTACT_COLUMNS } = await import("./whatsappContacts.routes.js");

const SA1 = "11111111-1111-4111-8111-111111111111";
const SA_OTHER = "22222222-2222-4222-8222-222222222222";
const NUMBER = "+27821234567";
const DIGITS_RE = /\d{7,}/;
const optIn = (over: Record<string, unknown> = {}) => ({
  source: "website_form",
  capturedAt: "2026-10-01",
  consentText: "I agree to receive offers from Acme on WhatsApp",
  proofReference: "form-991",
  attested: true,
  ...over,
});
const app = () => {
  const a = express();
  a.use("/whatsapp/contacts/import", ...whatsappContactsImportJsonParser);
  a.use(express.json());
  a.use(buildWhatsAppContactsRouter());
  return a;
};
const post = (path: string, body: unknown) => request(app()).post(path).send(body as object);
const addOne = (over: Record<string, unknown> = {}) => post("/whatsapp/contacts", { social_account_id: SA1, phone: NUMBER, name: "Thandi", optIn: optIn(), ...over });
const importBody = (rows: unknown[], over: Record<string, unknown> = {}) => ({
  social_account_id: SA1,
  source: "customer_import",
  consentText: "Customers ticked the WhatsApp offers box at checkout",
  capturedAt: "2026-10-01",
  attested: true,
  rows,
  ...over,
});
const row = (phone: string, over: Record<string, unknown> = {}) => ({ phone, name: "Sam", opted_in: "yes", ...over });

const SAVED = { ...process.env };
let logged: string[] = [];

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  ctx.account = "acc1";
  ctx.members = ["acc1"];
  ctx.signedIn = true;
  ctx.method = "jwt";
  ctx.canSee = true;
  ctx.planError = null;
  ctx.selects = [];
  process.env.WHATSAPP_BYOK_ENABLED = "true";
  process.env.WHATSAPP_BROADCASTS_ENABLED = "true";
  process.env.WHATSAPP_CONTACT_HASH_KEY = "h".repeat(40);
  process.env.WHATSAPP_CONTACT_ENC_KEY = randomBytes(32).toString("base64");
  process.env.WHATSAPP_CONTACT_ENC_KEY_ID = "k1";
  tables.social_accounts = [
    { id: SA1, account_id: "acc1", platform: "whatsapp" },
    { id: SA_OTHER, account_id: "acc2", platform: "whatsapp" },
  ];
  logged = [];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

describe("gating: flag, flag, visibility, plan, then human-only", () => {
  const paths = [
    () => request(app()).get("/whatsapp/contacts"),
    () => addOne(),
    () => post("/whatsapp/contacts/import", importBody([row(NUMBER)])),
    () => post("/whatsapp/contacts/c1/opt-out", {}),
    () => request(app()).delete("/whatsapp/contacts/c1"),
    () => request(app()).get("/whatsapp/opt-outs"),
  ];

  it("needs a sign-in", async () => {
    ctx.signedIn = false;
    for (const call of paths) expect((await call()).status).toBe(401);
  });

  it("404 when WHATSAPP_BYOK_ENABLED is off, even with everything else on and a plan error", async () => {
    process.env.WHATSAPP_BYOK_ENABLED = "off";
    ctx.planError = "upgrade";
    for (const call of paths) expect((await call()).status).toBe(404);
  });

  it("404 when WHATSAPP_BROADCASTS_ENABLED is off or unset, and when the account cannot see WhatsApp", async () => {
    process.env.WHATSAPP_BROADCASTS_ENABLED = "yes";
    for (const call of paths) expect((await call()).status).toBe(404);
    delete process.env.WHATSAPP_BROADCASTS_ENABLED;
    for (const call of paths) expect((await call()).status).toBe(404);
    process.env.WHATSAPP_BROADCASTS_ENABLED = "true";
    ctx.canSee = false;
    ctx.planError = "upgrade";
    for (const call of paths) expect((await call()).status).toBe(404);
  });

  it("400 with the plan message below Business", async () => {
    ctx.planError = "Connecting WhatsApp is available on the Business plan and above.";
    for (const call of paths) {
      const r = await call();
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/Business plan/);
    }
  });

  it("writes refuse an API key (403) but a switched-off feature still looks switched off (404)", async () => {
    ctx.method = "apiKey";
    expect((await addOne()).status).toBe(403);
    expect((await post("/whatsapp/contacts/import", importBody([row(NUMBER)]))).status).toBe(403);
    expect((await post("/whatsapp/contacts/c1/opt-out", {})).status).toBe(403);
    expect((await request(app()).delete("/whatsapp/contacts/c1")).status).toBe(403);
    process.env.WHATSAPP_BROADCASTS_ENABLED = "false";
    expect((await addOne()).status).toBe(404);
  });
});

describe("GET /whatsapp/capabilities", () => {
  const get = () => request(app()).get("/whatsapp/capabilities");

  it("says broadcasts are on only when every gate passes and the keys exist, and returns booleans only", async () => {
    let r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ broadcasts: true });
    for (const off of [() => (process.env.WHATSAPP_BROADCASTS_ENABLED = "false"), () => (process.env.WHATSAPP_BYOK_ENABLED = "false"), () => (ctx.canSee = false), () => (ctx.planError = "no"), () => delete process.env.WHATSAPP_CONTACT_ENC_KEY, () => delete process.env.WHATSAPP_CONTACT_HASH_KEY]) {
      process.env.WHATSAPP_BYOK_ENABLED = "true";
      process.env.WHATSAPP_BROADCASTS_ENABLED = "true";
      process.env.WHATSAPP_CONTACT_ENC_KEY = randomBytes(32).toString("base64");
      process.env.WHATSAPP_CONTACT_HASH_KEY = "h".repeat(40);
      ctx.canSee = true;
      ctx.planError = null;
      off();
      r = await get();
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ broadcasts: false });
    }
  });

  it("needs a sign-in", async () => {
    ctx.signedIn = false;
    expect((await get()).status).toBe(401);
  });
});

describe("POST /whatsapp/contacts", () => {
  it("stores the contact with an encrypted number, a masked display, hashed key, and a chained consent record", async () => {
    const r = await addOne();
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("created");
    const c = tables.whatsapp_contacts[0] as any;
    const o = tables.whatsapp_opt_ins[0] as any;
    expect(c.account_id).toBe("acc1");
    expect(c.contact_key).toMatch(/^[0-9a-f]{64}$/);
    expect(c.phone_ciphertext).toMatch(/^v1\.k1\./);
    expect(c.phone_ciphertext).not.toContain("27821234567");
    expect(c.contact_display).toMatch(/\*\*/);
    expect(c.contact_display).not.toMatch(DIGITS_RE);
    expect(c.country_calling_code).toBe("27");
    expect(c.display_name).toBe("Thandi");
    expect(c.consent_status).toBe("opted_in");
    expect(c.current_opt_in_id).toBe(o.id);
    expect(o).toMatchObject({ account_id: "acc1", contact_id: c.id, source: "website_form", attested: true, prev_hash: "0".repeat(64), recorded_by: "33333333-3333-4333-8333-333333333333" });
    expect(o.row_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(o.attestation_version).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toContain("27821234567");
    expect(JSON.stringify(r.body)).not.toContain("v1.k1");
  });

  it("refuses without the attestation, a valid source, consent wording, a past date, or a valid number", async () => {
    for (const bad of [
      { optIn: optIn({ attested: false }) },
      { optIn: optIn({ attested: undefined }) },
      { optIn: optIn({ source: "bought_list" }) },
      { optIn: optIn({ consentText: "" }) },
      { optIn: optIn({ consentText: "x".repeat(1001) }) },
      { optIn: optIn({ proofReference: "x".repeat(501) }) },
      { optIn: optIn({ capturedAt: "2999-01-01" }) },
      { optIn: optIn({ capturedAt: "yesterday" }) },
      { optIn: undefined },
      { phone: "0821234567" },
      { phone: "abc" },
      { name: "x".repeat(81) },
      { social_account_id: "nope" },
    ]) {
      const r = await addOne(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(tables.whatsapp_contacts ?? []).toHaveLength(0);
    expect(tables.whatsapp_opt_ins ?? []).toHaveLength(0);
  });

  it("404 for a connection that belongs to another account", async () => {
    expect((await addOne({ social_account_id: SA_OTHER })).status).toBe(404);
    expect(tables.whatsapp_contacts ?? []).toHaveLength(0);
  });

  it("answers 'duplicate' for a number already stored and writes nothing new", async () => {
    await addOne();
    const r = await addOne({ phone: "+27 82 123 4567" });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("duplicate");
    expect(tables.whatsapp_contacts).toHaveLength(1);
    expect(tables.whatsapp_opt_ins).toHaveLength(1);
  });

  it("refuses a number that has opted out (409) and stores nothing", async () => {
    await addOne();
    const id = (tables.whatsapp_contacts[0] as any).id;
    await post(`/whatsapp/contacts/${id}/opt-out`, {});
    tables.whatsapp_contacts.length = 0;
    tables.whatsapp_opt_ins.length = 0;
    const r = await addOne();
    expect(r.status).toBe(409);
    expect(r.body.status).toBe("suppressed");
    expect(tables.whatsapp_contacts).toHaveLength(0);
  });

  it("fails closed with 503 and writes nothing when the encryption or hash key is missing", async () => {
    delete process.env.WHATSAPP_CONTACT_ENC_KEY;
    expect((await addOne()).status).toBe(503);
    process.env.WHATSAPP_CONTACT_ENC_KEY = randomBytes(32).toString("base64");
    delete process.env.WHATSAPP_CONTACT_HASH_KEY;
    expect((await addOne()).status).toBe(503);
    expect(tables.whatsapp_contacts ?? []).toHaveLength(0);
  });

  it("never logs a phone number, a name or the consent wording", async () => {
    await addOne({ name: "Zanele Secretname" });
    await addOne({ phone: "0821234567" });
    await addOne({ phone: "+27 83 555 0000", optIn: optIn({ capturedAt: "2999-01-01" }) });
    const all = logged.join("\n");
    expect(all).not.toMatch(/27821234567|0821234567|27835550000|Secretname|receive offers from Acme/);
  });
});

describe("POST /whatsapp/contacts/import", () => {
  it("imports valid rows, rejecting rows without an affirmative opted_in or a usable number, and reports every outcome", async () => {
    const r = await post(
      "/whatsapp/contacts/import",
      importBody([
        row("+27821234567"),
        row("+27 83 555 0001", { opted_in: "no" }),
        row("+27 83 555 0002", { opted_in: "" }),
        row("0835550003"),
        row("+27 84 555 0004", { opt_in_date: "2999-01-01" }),
        row("+27 85 555 0005", { opt_in_date: "2026-09-30" }),
        row("", { opted_in: "yes" }),
        row("+27821234567"),
      ]),
    );
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(false);
    expect(r.body.accepted).toBe(2);
    expect(r.body.duplicates).toBe(1);
    expect(r.body.suppressed).toBe(0);
    expect(r.body.rejected).toEqual([
      { row: 2, reason: "opt_in_not_affirmative" },
      { row: 3, reason: "opt_in_not_affirmative" },
      { row: 4, reason: "phone_leading_zero_without_country_code" },
      { row: 5, reason: "opt_in_date_in_future" },
      { row: 7, reason: "phone_empty" },
    ]);
    expect(tables.whatsapp_contacts).toHaveLength(2);
    expect(tables.whatsapp_opt_ins).toHaveLength(2);
    const batches = new Set((tables.whatsapp_opt_ins as any[]).map((o) => o.import_batch_id));
    expect(batches.size).toBe(1);
    expect([...batches][0]).toBeTruthy();
    const dated = (tables.whatsapp_opt_ins as any[]).find((o) => String(o.captured_at).startsWith("2026-09-30"));
    expect(dated).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(DIGITS_RE);
    expect(logged.join("\n")).not.toMatch(/2782123|2783555|2785555/);
  });

  it("does not import numbers that opted out, and counts them as suppressed", async () => {
    await addOne();
    await post(`/whatsapp/contacts/${(tables.whatsapp_contacts[0] as any).id}/opt-out`, {});
    tables.whatsapp_contacts.length = 0;
    tables.whatsapp_opt_ins.length = 0;
    const r = await post("/whatsapp/contacts/import", importBody([row(NUMBER), row("+27 83 555 0001")]));
    expect(r.body).toMatchObject({ accepted: 1, suppressed: 1, duplicates: 0 });
    expect(tables.whatsapp_contacts).toHaveLength(1);
  });

  it("counts an already-opted-out stored contact as suppressed, not as a duplicate", async () => {
    await addOne();
    (tables.whatsapp_contacts[0] as any).consent_status = "opted_out";
    const r = await post("/whatsapp/contacts/import", importBody([row(NUMBER)]));
    expect(r.body).toMatchObject({ accepted: 0, suppressed: 1, duplicates: 0 });
  });

  it("dryRun validates and counts but writes nothing", async () => {
    const r = await post("/whatsapp/contacts/import", importBody([row(NUMBER), row("+27 83 555 0001", { opted_in: "no" })], { dryRun: true }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, accepted: 1, duplicates: 0, suppressed: 0, rejected: [{ row: 2, reason: "opt_in_not_affirmative" }] });
    expect(tables.whatsapp_contacts ?? []).toHaveLength(0);
    expect(tables.whatsapp_opt_ins ?? []).toHaveLength(0);
  });

  it("refuses without the request-level attestation, source, consent wording, rows, or with more than 5000 rows", async () => {
    for (const bad of [{ attested: false }, { attested: undefined }, { source: "other_thing" }, { consentText: "" }, { rows: [] }, { rows: "x" }, { capturedAt: "2999-01-01" }, { social_account_id: "nope" }]) {
      expect((await post("/whatsapp/contacts/import", importBody([row(NUMBER)], bad))).status, JSON.stringify(bad)).toBe(400);
    }
    const many = Array.from({ length: 5001 }, (_, i) => row(`+2782${String(1000000 + i)}`));
    expect((await post("/whatsapp/contacts/import", importBody(many))).status).toBe(400);
    expect(tables.whatsapp_contacts ?? []).toHaveLength(0);
  });

  it("accepts exactly 5000 rows", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(`+2782${String(1000000 + i)}`));
    const r = await post("/whatsapp/contacts/import", importBody(rows, { dryRun: true }));
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(5000);
  });

  it("its own parser accepts a few hundred KB and refuses more than 2 MB with a fixed message", async () => {
    const big = importBody(Array.from({ length: 5000 }, (_, i) => row(`+2782${String(1000000 + i)}`, { name: "N".repeat(40) })), { dryRun: true });
    expect(JSON.stringify(big).length).toBeGreaterThan(300_000);
    expect((await post("/whatsapp/contacts/import", big)).status).toBe(200);
    const huge = importBody([row(NUMBER, { name: "x".repeat(2_200_000) })]);
    const r = await post("/whatsapp/contacts/import", huge);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain("xxxxxxxx");
    expect(logged.join("\n")).not.toContain("xxxxxxxx");
  });

  it("404 for another account's connection", async () => {
    expect((await post("/whatsapp/contacts/import", importBody([row(NUMBER)], { social_account_id: SA_OTHER }))).status).toBe(404);
  });

  it("fails closed with 503 when the keys are missing, even for a dry run", async () => {
    delete process.env.WHATSAPP_CONTACT_ENC_KEY;
    expect((await post("/whatsapp/contacts/import", importBody([row(NUMBER)], { dryRun: true }))).status).toBe(503);
  });
});

describe("GET /whatsapp/contacts", () => {
  const seed = () => {
    tables.whatsapp_contacts = [
      { id: "c1", account_id: "acc1", social_account_id: SA1, contact_key: "a".repeat(64), contact_display: "+27 ** *** 1111", display_name: "Thandi", country_calling_code: "27", consent_status: "opted_in", opted_in_at: "2026-10-01T00:00:00Z", opted_out_at: null, created_at: "2026-10-10T10:00:00.000Z", phone_ciphertext: "v1.k1.SECRETCIPHER.x.y" },
      { id: "c2", account_id: "acc1", social_account_id: SA1, contact_key: "b".repeat(64), contact_display: "+27 ** *** 2222", display_name: "Pieter", country_calling_code: "27", consent_status: "opted_out", opted_in_at: "2026-10-01T00:00:00Z", opted_out_at: "2026-10-12T00:00:00Z", created_at: "2026-10-11T10:00:00.000Z", phone_ciphertext: "v1.k1.SECRETCIPHER.x.y" },
      { id: "c3", account_id: "acc2", social_account_id: SA_OTHER, contact_key: "c".repeat(64), contact_display: "+44 ** *** 3333", display_name: "Other Customer", country_calling_code: "44", consent_status: "opted_in", opted_in_at: "2026-10-01T00:00:00Z", opted_out_at: null, created_at: "2026-10-12T10:00:00.000Z", phone_ciphertext: "v1.k1.SECRETCIPHER.x.y" },
    ];
  };
  const get = (q: Record<string, string | number> = {}) => request(app()).get("/whatsapp/contacts").query(q);

  it("uses an explicit column list that never names the ciphertext and never uses *", async () => {
    seed();
    await get();
    expect(WHATSAPP_CONTACT_COLUMNS).not.toMatch(/phone|cipher|\*/);
    const used = ctx.selects.find((s) => s.startsWith("whatsapp_contacts:"));
    expect(used).toBe(`whatsapp_contacts:${WHATSAPP_CONTACT_COLUMNS}`);
  });

  it("returns only this account's contacts, newest first, and never the ciphertext or a number", async () => {
    seed();
    ctx.members = ["acc1", "acc2"]; // even a policy that allowed both: the explicit account filter still isolates
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.contacts.map((c: { id: string }) => c.id)).toEqual(["c2", "c1"]);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/SECRETCIPHER|cipher|phone/i);
    expect(text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "")).not.toMatch(DIGITS_RE); // ids are UUIDs
    expect(Object.keys(r.body.contacts[0]).sort()).toEqual(["consentStatus", "contactDisplay", "contactKey", "countryCallingCode", "createdAt", "displayName", "id", "optedInAt", "optedOutAt", "socialAccountId"].sort());
  });

  it("filters by connection, status, and a search on the mask or the name only", async () => {
    seed();
    expect((await get({ status: "opted_out" })).body.contacts.map((c: { id: string }) => c.id)).toEqual(["c2"]);
    expect((await get({ social_account_id: SA_OTHER })).body.contacts).toEqual([]);
    expect((await get({ search: "1111" })).body.contacts.map((c: { id: string }) => c.id)).toEqual(["c1"]);
    expect((await get({ search: "pieter" })).body.contacts.map((c: { id: string }) => c.id)).toEqual(["c2"]);
  });

  it("refuses a search that looks like a phone number (it would sit in the URL and logs) and bad parameters", async () => {
    seed();
    expect((await get({ search: "27821234567" })).status).toBe(400);
    expect((await get({ status: "weird" })).status).toBe(400);
    expect((await get({ limit: 1000 })).status).toBe(400);
  });
});

describe("POST /whatsapp/contacts/:id/opt-out", () => {
  it("records a hash-only opt-out and marks the contact opted out, idempotently", async () => {
    await addOne();
    const c = tables.whatsapp_contacts[0] as any;
    const r = await post(`/whatsapp/contacts/${c.id}/opt-out`, {});
    expect(r.status).toBe(200);
    expect(c.consent_status).toBe("opted_out");
    expect(c.opted_out_at).toBeTruthy();
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
    const o = tables.whatsapp_opt_outs[0] as any;
    expect(o).toMatchObject({ account_id: "acc1", contact_key: c.contact_key, contact_display: c.contact_display, scope: "all", source: "manual" });
    expect(JSON.stringify(o)).not.toMatch(/phone|cipher|Thandi|27821234567/);
    expect((await post(`/whatsapp/contacts/${c.id}/opt-out`, {})).status).toBe(200);
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
  });

  it("404 for another account's contact and for an unknown id", async () => {
    tables.whatsapp_contacts = [{ id: "cx", account_id: "acc2", social_account_id: SA_OTHER, contact_key: "c".repeat(64), contact_display: "+44 ** *** 3333", consent_status: "opted_in" }];
    expect((await post("/whatsapp/contacts/cx/opt-out", {})).status).toBe(404);
    expect((await post("/whatsapp/contacts/nope/opt-out", {})).status).toBe(404);
    expect((tables.whatsapp_opt_outs ?? []).length).toBe(0);
    expect((tables.whatsapp_contacts[0] as any).consent_status).toBe("opted_in");
  });
});

describe("DELETE /whatsapp/contacts/:id (erase)", () => {
  it("deletes the contact but leaves the hash-only opt-out list alone", async () => {
    await addOne();
    const c = tables.whatsapp_contacts[0] as any;
    await post(`/whatsapp/contacts/${c.id}/opt-out`, {});
    const r = await request(app()).delete(`/whatsapp/contacts/${c.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(tables.whatsapp_contacts).toHaveLength(0);
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
  });

  it("404 for another account's contact, which stays untouched", async () => {
    tables.whatsapp_contacts = [{ id: "cx", account_id: "acc2", social_account_id: SA_OTHER, contact_key: "c".repeat(64), contact_display: "x", consent_status: "opted_in" }];
    expect((await request(app()).delete("/whatsapp/contacts/cx")).status).toBe(404);
    expect(tables.whatsapp_contacts).toHaveLength(1);
  });
});

describe("GET /whatsapp/opt-outs", () => {
  it("returns a count and a masked list for this account only", async () => {
    tables.whatsapp_opt_outs = [
      { id: "o1", account_id: "acc1", contact_key: "a".repeat(64), contact_display: "+27 ** *** 1111", wa_contact_key: null, scope: "all", source: "keyword", keyword: "STOP", occurred_at: "2026-10-12T10:00:00.000Z", created_at: "2026-10-12T10:00:00.000Z" },
      { id: "o2", account_id: "acc1", contact_key: "b".repeat(64), contact_display: "+27 ** *** 2222", wa_contact_key: null, scope: "all", source: "manual", keyword: null, occurred_at: "2026-10-13T10:00:00.000Z", created_at: "2026-10-13T10:00:00.000Z" },
      { id: "o3", account_id: "acc2", contact_key: "c".repeat(64), contact_display: "+44 ** *** 3333", wa_contact_key: null, scope: "all", source: "keyword", keyword: "STOP", occurred_at: "2026-10-14T10:00:00.000Z", created_at: "2026-10-14T10:00:00.000Z" },
    ];
    ctx.members = ["acc1", "acc2"];
    const r = await request(app()).get("/whatsapp/opt-outs");
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(r.body.optOuts.map((o: { id: string }) => o.id)).toEqual(["o2", "o1"]);
    expect(Object.keys(r.body.optOuts[0]).sort()).toEqual(["contactDisplay", "id", "keyword", "occurredAt", "scope", "source"].sort());
    expect(JSON.stringify(r.body)).not.toMatch(/[0-9a-f]{64}/);
  });
});
