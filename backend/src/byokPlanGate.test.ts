// The plan gate for the customer's OWN keys (X own developer keys, WhatsApp own Meta credentials). Werner's rule: every PAID tier from
// Starter up (Starter, Pro, Business, Agency, Agency Plus) may use them with no metering; Free and lapsed accounts are refused. These
// tests use the REAL resolveTier / checkWhatsappPlan / canUse* against the in-memory fake, over every tier and every subscription state,
// and keep the unapplied database trigger migration in step with the backend lists.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tables } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: async () => ({ data: null, error: null }) } };
});

const { canUseXByok, canUseWhatsappByok, resolveTier, X_BYOK_ALLOWED_TIERS, WHATSAPP_BYOK_ALLOWED_TIERS, X_BYOK_REQUIRED_PLAN_NAME, WHATSAPP_BYOK_REQUIRED_PLAN_NAME } = await import("./tier.js");
const { checkWhatsappPlan, WHATSAPP_PLAN_MESSAGE, WHATSAPP_DB_GATE_MESSAGE, X_BYOK_DB_GATE_MESSAGE, isWhatsappPlanGateError, isXByokPlanGateError } = await import("./accountLimits.js");
import type { Tier } from "./tier.js";

const PAID: Tier[] = ["starter", "pro", "business", "agency", "agency_plus"];
const NEW_PLANS: Tier[] = ["growth", "lazy_pro", "payg"];
const ALLOWED: Tier[] = [...PAID, ...NEW_PLANS];
const ALL: Tier[] = ["free", ...ALLOWED];
const GOOD_STANDING = ["active", "trialing"];
const LAPSED = ["canceled", "cancelled", "past_due", "paused", "unpaid", "incomplete", "expired", ""];

beforeEach(() => {
  tables.subscriptions = [];
});
const sub = (tier: string, status: string) => void (tables.subscriptions = [{ account_id: "acc1", tier, status }]);

describe("the tier lists", () => {
  it("X own keys and WhatsApp own keys are open to every paid tier and to nobody else", () => {
    expect([...X_BYOK_ALLOWED_TIERS].sort()).toEqual([...ALLOWED].sort());
    expect([...WHATSAPP_BYOK_ALLOWED_TIERS].sort()).toEqual([...ALLOWED].sort());
    expect(canUseXByok("free")).toBe(false);
    expect(canUseWhatsappByok("free")).toBe(false);
    for (const t of ALLOWED) {
      expect(canUseXByok(t), `X ${t}`).toBe(true);
      expect(canUseWhatsappByok(t), `WhatsApp ${t}`).toBe(true);
    }
  });

  it("the plan named in upgrade messages is the cheapest paid plan, Starter", () => {
    expect(X_BYOK_REQUIRED_PLAN_NAME).toBe("Starter");
    expect(WHATSAPP_BYOK_REQUIRED_PLAN_NAME).toBe("Starter");
  });
});

describe("the real plan check, tier by tier and state by state", () => {
  it.each(ALL.flatMap((t) => GOOD_STANDING.map((s) => [t, s] as const)))("%s in good standing (%s): allowed iff paid, for X and for WhatsApp", async (tier, status) => {
    sub(tier, status);
    const resolved = await resolveTier("acc1");
    expect(resolved).toBe(tier);
    expect(canUseXByok(resolved)).toBe(tier !== "free");
    expect(canUseWhatsappByok(resolved)).toBe(tier !== "free");
    expect(await checkWhatsappPlan("acc1")).toBe(tier === "free" ? WHATSAPP_PLAN_MESSAGE : null);
  });

  it.each(PAID.flatMap((t) => LAPSED.map((s) => [t, s] as const)))("a lapsed paid plan (%s, status '%s') counts as Free and is refused", async (tier, status) => {
    sub(tier, status);
    expect(await resolveTier("acc1")).toBe("free");
    expect(canUseXByok(await resolveTier("acc1"))).toBe(false);
    expect(await checkWhatsappPlan("acc1")).toBe(WHATSAPP_PLAN_MESSAGE);
  });

  it("no subscription row at all is Free and refused", async () => {
    expect(await resolveTier("acc1")).toBe("free");
    expect(await checkWhatsappPlan("acc1")).toBe(WHATSAPP_PLAN_MESSAGE);
  });

  it("an unreadable plan fails closed", async () => {
    Object.defineProperty(tables, "subscriptions", { get() { throw new Error("db down"); }, configurable: true });
    try {
      expect(await checkWhatsappPlan("acc1")).toBe(WHATSAPP_PLAN_MESSAGE);
    } finally {
      Object.defineProperty(tables, "subscriptions", { value: [], writable: true, configurable: true, enumerable: true });
    }
  });

  it("the upgrade messages say a paid plan is enough, and name no higher tier", () => {
    expect(WHATSAPP_PLAN_MESSAGE).toMatch(/paid plan/i);
    expect(WHATSAPP_PLAN_MESSAGE).not.toMatch(/Pro|Business|Agency/);
  });
});

describe("migration 0132 (the database backstop for both gates) matches the backend", () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
  const name = fs.readdirSync(dir).find((f) => f.startsWith("0132_"));
  const sql = name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
  const code = sql.replace(/^\s*--.*$/gm, "");
  const lists = [...code.matchAll(/v_tier in \(([^)]*)\)/g)].map((m) => m[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort());

  it("exists, is idempotent, one transaction, marked not applied, with a rollback note", () => {
    expect(name).toBe("0132_byok_paid_plan_gate.sql");
    expect(code).toMatch(/^\s*begin;/m);
    expect(code).toMatch(/commit;\s*$/);
    expect(sql).toMatch(/NOT applied anywhere/i);
    expect(sql).toMatch(/ROLLBACK/);
  });

  it("replaces both trigger functions, with the same tiers as tier.ts (every paid tier)", () => {
    expect(code).toContain("create or replace function public.enforce_whatsapp_plan_gate()");
    expect(code).toContain("create or replace function public.enforce_x_byok_plan_gate()");
    expect(lists).toHaveLength(2);
    for (const l of lists) expect(l).toEqual([...PAID].sort());
  });

  it("keeps the SQLSTATEs and the good-standing test, and says 'a paid plan'", () => {
    expect(code).toContain("errcode = 'LRWA1'");
    expect(code).toContain("errcode = 'LRXB1'");
    expect(code.match(/v_status in \('active', 'trialing'\)/g)).toHaveLength(2);
    expect(code).toContain(`'${WHATSAPP_DB_GATE_MESSAGE}'`);
    expect(code).toContain(`'${X_BYOK_DB_GATE_MESSAGE}'`);
    expect(WHATSAPP_DB_GATE_MESSAGE).toBe("whatsapp requires a paid plan");
    expect(X_BYOK_DB_GATE_MESSAGE).toBe("x own keys requires a paid plan");
  });

  it("the backend still recognises the old messages and the SQLSTATEs (a database not yet migrated)", () => {
    expect(isWhatsappPlanGateError({ code: "LRWA1", message: "anything" })).toBe(true);
    expect(isXByokPlanGateError({ code: "LRXB1", message: "anything" })).toBe(true);
    expect(isWhatsappPlanGateError({ message: "whatsapp requires the Business plan or above" })).toBe(true);
    expect(isXByokPlanGateError({ message: "x own keys requires the Pro plan or above" })).toBe(true);
  });
});

describe("migration 0143 (database backstop extended to the wallet plans)", () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
  const name = fs.readdirSync(dir).find((f) => f.startsWith("0143_"));
  const sql = name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
  const code = sql.replace(/^\s*--.*$/gm, "");
  const lists = [...code.matchAll(/v_tier in \(([^)]*)\)/g)].map((m) => m[1].split(",").map((x) => x.trim().replace(/'/g, "")));

  it("exists, one transaction, idempotent, marked not applied, with a rollback note", () => {
    expect(name).toBe("0143_own_keys_new_plans.sql");
    expect(code).toMatch(/^\s*begin;/m);
    expect(code).toMatch(/commit;\s*$/);
    expect(sql).toMatch(/NOT applied anywhere/i);
    expect(sql).toMatch(/ROLLBACK/);
    expect(code).not.toMatch(/create function/i);
  });

  it("replaces both functions; the stored tiers match tier.ts and payg is allowed through the unlock column", () => {
    expect(code).toContain("create or replace function public.enforce_whatsapp_plan_gate()");
    expect(code).toContain("create or replace function public.enforce_x_byok_plan_gate()");
    expect(lists).toHaveLength(2);
    const stored = ALLOWED.filter((t) => t !== "payg").sort();
    for (const l of lists) expect([...l].sort()).toEqual(stored);
    expect(code.match(/payg_unlocked_at is not null/g)).toHaveLength(2);
  });

  it("keeps the SQLSTATEs, the good-standing test and the messages of 0132", () => {
    expect(code).toContain("errcode = 'LRWA1'");
    expect(code).toContain("errcode = 'LRXB1'");
    expect(code.match(/v_status in \('active', 'trialing'\)/g)).toHaveLength(2);
    expect(code).toContain(`'${WHATSAPP_DB_GATE_MESSAGE}'`);
    expect(code).toContain(`'${X_BYOK_DB_GATE_MESSAGE}'`);
  });
});
