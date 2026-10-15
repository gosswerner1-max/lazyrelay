// GET /whatsapp/messages: the stored inbound WhatsApp messages of one connection, newest first. Sign-in and the feature
// flag, validation, paging, a thread filter, cross-account isolation (the explicit account filter AND a simulated row level
// security policy), and that no raw phone number ever comes back. Supabase is the in-memory fake.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

const ctx = vi.hoisted(() => ({ account: "acc1", members: ["acc1"] as string[], signedIn: true }));
vi.mock("../auth.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    requireAuth: (req: any, res: any, next: any) => {
      if (!ctx.signedIn) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      req.accountId = ctx.account;
      // Simulates the row level security policy: the caller's role only ever sees rows of accounts they belong to.
      req.db = {
        from: (t: string) => {
          const b: any = f.makeBuilder(t);
          const select = b.select;
          b.select = (cols?: string, o?: unknown) => (select(cols, o), b.in("account_id", ctx.members));
          return b;
        },
      };
      next();
    },
  };
});
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_r: any, _s: any, n: any) => n() }));

const { buildWhatsAppMessagesRouter } = await import("./whatsappMessages.routes.js");

const SA1 = "11111111-1111-4111-8111-111111111111";
const SA2 = "22222222-2222-4222-8222-222222222222";
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `m${i}`, account_id: "acc1", social_account_id: SA1, wamid: String(i).padStart(64, "0"), contact_key: KEY_A, contact_display: "+27 ** *** 1111",
  contact_name: "Thandi", text: `message ${i}`, received_at: new Date(Date.UTC(2026, 9, 10, 10, i)).toISOString(),
  triage_category: null, needs_attention: null, triage_reason: null, triaged_at: null, ...over,
});
const app = () => {
  const a = express();
  a.use(buildWhatsAppMessagesRouter());
  return a;
};
const get = (q: Record<string, string | number>) => request(app()).get("/whatsapp/messages").query(q);

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  ctx.account = "acc1";
  ctx.members = ["acc1"];
  ctx.signedIn = true;
  process.env.WHATSAPP_BYOK_ENABLED = "true";
  tables.whatsapp_messages = [row(1), row(2), row(3, { contact_key: KEY_B, contact_name: "Pieter" })];
});
afterEach(() => {
  delete process.env.WHATSAPP_BYOK_ENABLED;
  vi.restoreAllMocks();
});

describe("GET /whatsapp/messages", () => {
  it("needs a sign-in and the feature switched on", async () => {
    ctx.signedIn = false;
    expect((await get({ social_account_id: SA1 })).status).toBe(401);
    ctx.signedIn = true;
    process.env.WHATSAPP_BYOK_ENABLED = "off";
    expect((await get({ social_account_id: SA1 })).status).toBe(404);
  });

  it("returns the connection's messages newest first, with the documented fields", async () => {
    const r = await get({ social_account_id: SA1 });
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m: { text: string }) => m.text)).toEqual(["message 3", "message 2", "message 1"]);
    expect(Object.keys(r.body.messages[0]).sort()).toEqual(
      ["contactDisplay", "contactKey", "contactName", "id", "needsAttention", "receivedAt", "text", "triageCategory", "triageReason", "triagedAt", "wamid"].sort(),
    );
    expect(r.body.nextBefore).toBeNull();
  });

  it("filters to one thread with contact_key", async () => {
    const r = await get({ social_account_id: SA1, contact_key: KEY_A });
    expect(r.body.messages.map((m: { text: string }) => m.text)).toEqual(["message 2", "message 1"]);
  });

  it("pages with limit and before, newest first, and stops cleanly", async () => {
    tables.whatsapp_messages = Array.from({ length: 5 }, (_, i) => row(i + 1));
    const p1 = await get({ social_account_id: SA1, limit: 2 });
    expect(p1.body.messages.map((m: { text: string }) => m.text)).toEqual(["message 5", "message 4"]);
    expect(p1.body.nextBefore).toBe(p1.body.messages[1].receivedAt);
    const p2 = await get({ social_account_id: SA1, limit: 2, before: p1.body.nextBefore });
    expect(p2.body.messages.map((m: { text: string }) => m.text)).toEqual(["message 3", "message 2"]);
    const p3 = await get({ social_account_id: SA1, limit: 2, before: p2.body.nextBefore });
    expect(p3.body.messages.map((m: { text: string }) => m.text)).toEqual(["message 1"]);
    expect(p3.body.nextBefore).toBeNull();
  });

  it("validates its parameters: a connection id is required, the limit is 1 to 100", async () => {
    for (const q of [{}, { social_account_id: "abc" }, { social_account_id: SA1, limit: 0 }, { social_account_id: SA1, limit: 101 }, { social_account_id: SA1, contact_key: "short" }, { social_account_id: SA1, before: "yesterday" }]) {
      expect((await get(q as never)).status, JSON.stringify(q)).toBe(400);
    }
    expect((await get({ social_account_id: SA1, limit: 100 })).status).toBe(200);
  });

  it("never shows another account's messages, even when asked for that account's connection id", async () => {
    tables.whatsapp_messages = [row(1), row(2, { account_id: "acc2", social_account_id: SA2, text: "other customer" })];
    const mine = await get({ social_account_id: SA2 });
    expect(mine.status).toBe(200);
    expect(mine.body.messages).toEqual([]);
    // the explicit account filter alone is enough: a caller who is (wrongly) a member of both still gets only the active account
    ctx.members = ["acc1", "acc2"];
    expect((await get({ social_account_id: SA2 })).body.messages).toEqual([]);
    // and the other account sees its own
    ctx.account = "acc2";
    expect((await get({ social_account_id: SA2 })).body.messages.map((m: { text: string }) => m.text)).toEqual(["other customer"]);
    expect((await get({ social_account_id: SA1 })).body.messages).toEqual([]);
  });

  it("the policy alone also isolates: a caller who is not a member of the owning account reads nothing", async () => {
    ctx.members = ["acc9"]; // the row level security stand-in
    expect((await get({ social_account_id: SA1 })).body.messages).toEqual([]);
  });

  it("never returns a raw phone number: only the key and the mask", async () => {
    const r = await get({ social_account_id: SA1 });
    const all = JSON.stringify(r.body);
    const withoutHashes = all.replace(/[0-9a-f]{64}/g, "");
    expect(withoutHashes).not.toMatch(/d{7,}/); // no long digit run anywhere outside the two hashed fields
    for (const m of r.body.messages) {
      expect(m.contactKey).toMatch(/^[0-9a-f]{64}$/);
      expect(m.contactDisplay).toBe("+27 ** *** 1111");
      expect(Object.keys(m)).not.toContain("from");
      expect(Object.keys(m)).not.toContain("phone");
    }
    expect(all).not.toContain("27820001111");
  });
});
