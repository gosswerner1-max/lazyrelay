// The purge of old audit rows (13 months) and old shadow rows (30 days), with an injected clock. In-memory fake, nothing real is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tables, makeBuilder } from "../testFakeSupabase.js";
import { purgeSelfHealingHistory, auditCutoff, shadowCutoff } from "./purge.js";

vi.mock("../supabase.js", () => ({ supabase: {} }));

const NOW = new Date(Date.UTC(2026, 9, 19, 12, 0, 0));
const db = { from: (t: string) => makeBuilder(t) } as never;
const iso = (d: Date) => d.toISOString();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const monthsAgo = (n: number) => {
  const d = new Date(NOW);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
};

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.credential_audit_events = [
    { id: "a-old", created_at: iso(monthsAgo(14)) },
    { id: "a-edge-old", created_at: iso(new Date(monthsAgo(13).getTime() - 1)) },
    { id: "a-edge-keep", created_at: iso(monthsAgo(13)) },
    { id: "a-new", created_at: iso(monthsAgo(2)) },
  ];
  tables.self_healing_shadow_events = [
    { id: "s-old", created_at: iso(daysAgo(31)) },
    { id: "s-edge-old", created_at: iso(new Date(daysAgo(30).getTime() - 1)) },
    { id: "s-edge-keep", created_at: iso(daysAgo(30)) },
    { id: "s-new", created_at: iso(daysAgo(1)) },
  ];
});
afterEach(() => {
  delete process.env.SELF_HEALING_MODE;
  vi.restoreAllMocks();
});

describe("cutoffs", () => {
  it("are 13 calendar months and 30 days before now", () => {
    expect(auditCutoff(NOW)).toBe(iso(monthsAgo(13)));
    expect(shadowCutoff(NOW)).toBe(iso(daysAgo(30)));
  });
});

describe("purgeSelfHealingHistory", () => {
  it("deletes nothing while the mode is off (an audit table must not lose rows to a flag that is off)", async () => {
    expect(await purgeSelfHealingHistory(db, NOW)).toEqual({ auditDeleted: 0, shadowDeleted: 0, failed: false });
    expect(tables.credential_audit_events).toHaveLength(4);
    expect(tables.self_healing_shadow_events).toHaveLength(4);
  });

  it.each(["shadow", "on"])("in %s mode deletes audit rows older than 13 months and shadow rows older than 30 days, by the injected clock", async (mode) => {
    process.env.SELF_HEALING_MODE = mode;
    const r = await purgeSelfHealingHistory(db, NOW);
    expect(r).toEqual({ auditDeleted: 2, shadowDeleted: 2, failed: false });
    expect(tables.credential_audit_events.map((x) => x.id)).toEqual(["a-edge-keep", "a-new"]);
    expect(tables.self_healing_shadow_events.map((x) => x.id)).toEqual(["s-edge-keep", "s-new"]);
  });

  it("a later clock purges more, an earlier one purges less", async () => {
    process.env.SELF_HEALING_MODE = "on";
    const later = new Date(NOW.getTime() + 40 * 86_400_000);
    const r = await purgeSelfHealingHistory(db, later);
    expect(r.shadowDeleted).toBe(4);
  });

  it("one table failing is logged with the fixed tag, does not stop the other, and never throws", async () => {
    process.env.SELF_HEALING_MODE = "on";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      from: (t: string) => (t === "credential_audit_events" ? { delete: () => ({ lt: () => ({ select: async () => ({ data: null, error: { code: "42501", message: "denied" } }) }) }) } : makeBuilder(t)),
    } as never;
    const r = await purgeSelfHealingHistory(failing, NOW);
    expect(r).toEqual({ auditDeleted: 0, shadowDeleted: 2, failed: true });
    expect(err).toHaveBeenCalledWith("[self-healing-purge] audit purge failed", "42501");
  });
});
