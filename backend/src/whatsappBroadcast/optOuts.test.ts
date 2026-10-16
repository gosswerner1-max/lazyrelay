// Opt-outs from the two places they now arrive: Meta's error 131050 on a send or a receipt, and a STOP-style reply on the inbound
// webhook. Both write the hash-only suppression row (no number, no link to a contact) and flip the stored contact to opted out.
// Supabase is the in-memory fake.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables } from "../testFakeSupabase.js";

vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  const k = await import("./testKit.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, a: Record<string, unknown>) => k.fakeRpcAll(fn, a) } };
});

const { recordOptOutForContact, recordInboundOptOuts, isSuppressed } = await import("./optOuts.js");
const { ACC, ACC_OTHER, seedWorld, resetTables, setTestEnv, addContact, addOptOut } = await import("./testKit.js");
const { contactKeyFor } = await import("../platforms/whatsapp/contactPrivacy.js");

const NOW = new Date("2026-10-16T12:00:00.000Z");

beforeEach(() => {
  resetTables();
  seedWorld();
  setTestEnv();
});

describe("recordOptOutForContact", () => {
  it("writes one hash-only suppression row and flips the contact to opted out", async () => {
    const c = addContact("+27821110001");
    expect(await recordOptOutForContact(ACC, c.id as string, { scope: "marketing", source: "meta_131050" }, NOW)).toBe(true);
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
    expect(tables.whatsapp_opt_outs[0]).toMatchObject({ account_id: ACC, contact_key: c.contact_key, contact_display: c.contact_display, scope: "marketing", source: "meta_131050" });
    expect(Object.keys(tables.whatsapp_opt_outs[0])).not.toContain("contact_id");
    expect(JSON.stringify(tables.whatsapp_opt_outs)).not.toMatch(/27821110001/);
    expect(c.consent_status).toBe("opted_out");
    expect(c.opted_out_at).toBe(NOW.toISOString());
  });

  it("is idempotent", async () => {
    const c = addContact("+27821110001");
    await recordOptOutForContact(ACC, c.id as string, { scope: "marketing", source: "meta_131050" }, NOW);
    await recordOptOutForContact(ACC, c.id as string, { scope: "marketing", source: "meta_131050" }, NOW);
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
  });

  it("does nothing for another account's contact", async () => {
    const c = addContact("+27821110001");
    expect(await recordOptOutForContact(ACC_OTHER, c.id as string, { scope: "all", source: "keyword", keyword: "STOP" }, NOW)).toBe(false);
    expect(tables.whatsapp_opt_outs).toHaveLength(0);
    expect(c.consent_status).toBe("opted_in");
  });
});

describe("isSuppressed", () => {
  it("matches by either key, in either direction", async () => {
    const c = addContact("+27821110001");
    expect(await isSuppressed(ACC, c as never)).toBe(false);
    addOptOut(c);
    expect(await isSuppressed(ACC, c as never)).toBe(true);
    expect(await isSuppressed(ACC_OTHER, c as never)).toBe(false);
  });

  it("matches a contact whose wa key is the opt-out's contact key", async () => {
    const c = addContact("+27821110001");
    tables.whatsapp_opt_outs.push({ id: "o", account_id: ACC, contact_key: "f".repeat(64), wa_contact_key: c.contact_key, scope: "all" });
    expect(await isSuppressed(ACC, c as never)).toBe(true);
  });
});

describe("recordInboundOptOuts", () => {
  const account = { id: "11111111-1111-4111-8111-111111111111", account_id: ACC };

  it("a STOP reply from a stored contact opts them out (scope all, source keyword)", async () => {
    const c = addContact("+27821110001");
    const n = await recordInboundOptOuts(account, [{ from: "27821110001", text: "STOP" }], NOW);
    expect(n).toBe(1);
    expect(c.consent_status).toBe("opted_out");
    expect(tables.whatsapp_opt_outs[0]).toMatchObject({ scope: "all", source: "keyword", keyword: "STOP" });
  });

  it("accepts the other keywords and trailing punctuation, ignores ordinary sentences", async () => {
    const a = addContact("+27821110001");
    const b = addContact("+27821110002");
    const d = addContact("+27821110003");
    await recordInboundOptOuts(account, [{ from: "27821110001", text: " unsubscribe! " }, { from: "27821110002", text: "stop the car" }, { from: "27821110003", text: "I want to cancel my order" }], NOW);
    expect([a.consent_status, b.consent_status, d.consent_status]).toEqual(["opted_out", "opted_in", "opted_in"]);
  });

  it("a STOP from a number that is not a stored contact still leaves a hash-only suppression row, so a later import is blocked", async () => {
    await recordInboundOptOuts(account, [{ from: "27829990000", text: "STOP" }], NOW);
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
    expect(tables.whatsapp_opt_outs[0].contact_key).toBe(contactKeyFor(ACC, "27829990000"));
    expect(JSON.stringify(tables.whatsapp_opt_outs)).not.toMatch(/27829990000/);
  });

  it("the same person texting STOP twice is one row", async () => {
    addContact("+27821110001");
    await recordInboundOptOuts(account, [{ from: "27821110001", text: "STOP" }, { from: "27821110001", text: "stop" }], NOW);
    expect(tables.whatsapp_opt_outs).toHaveLength(1);
  });

  it("with no hash key configured nothing is written (and nothing is guessed)", async () => {
    delete process.env.WHATSAPP_CONTACT_HASH_KEY;
    expect(await recordInboundOptOuts(account, [{ from: "27821110001", text: "STOP" }], NOW)).toBe(0);
    expect(tables.whatsapp_opt_outs).toHaveLength(0);
  });
});
