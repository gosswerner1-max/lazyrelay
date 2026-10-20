import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TIER_DISPLAY_NAMES } from "./tier.js";

// Migration 0141 lets subscriptions store the two new stored tiers and adds the wallet columns. It is NOT applied anywhere; these
// tests keep it in step with the Tier union (TIER_DISPLAY_NAMES is a Record<Tier, string>, so its keys are exactly the union).

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
const name = fs.readdirSync(dir).find((f) => f.startsWith("0141_"));
const sql = name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
const code = sql.replace(/^\s*--.*$/gm, "");
const check = code.match(/add constraint subscriptions_tier_check\s+check \(tier in \(([^)]*)\)\)/)?.[1] ?? "";
const listed = check.split(",").map((x) => x.trim().replace(/'/g, "")).filter(Boolean).sort();
const storable = Object.keys(TIER_DISPLAY_NAMES).filter((t) => t !== "payg").sort();

describe("migration 0141 (wallet tiers)", () => {
  it("exists under the expected name, marked not applied, with a manual rollback", () => {
    expect(name).toBe("0141_wallet_tiers.sql");
    expect(sql).toMatch(/NOT applied anywhere/i);
    expect(sql).toMatch(/ROLLBACK/);
  });

  it("lists every Tier that can be stored, and not the derived payg", () => {
    expect(listed).toEqual(storable);
    expect(listed).not.toContain("payg");
    expect(listed).toEqual(expect.arrayContaining(["growth", "lazy_pro", "starter", "pro", "business", "agency", "agency_plus", "free"]));
  });

  it("drops the old constraint before recreating it, so a second run is harmless", () => {
    expect(code).toMatch(/drop constraint if exists subscriptions_tier_check/);
    expect(code.indexOf("drop constraint if exists subscriptions_tier_check")).toBeLessThan(code.indexOf("add constraint subscriptions_tier_check"));
  });

  it("adds the wallet columns and the partial index, all idempotent", () => {
    expect(code).toMatch(/alter table public\.accounts add column if not exists payg_unlocked_at timestamptz/);
    expect(code).toMatch(/alter table public\.scheduled_posts add column if not exists charge_group_id uuid/);
    expect(code).toMatch(/create index if not exists \w+\s+on public\.scheduled_posts \(charge_group_id\)\s+where charge_group_id is not null/);
  });

  it("is additive: nothing is dropped except the one constraint, no data is rewritten", () => {
    expect(code.match(/\bdrop\b/g)).toHaveLength(1);
    expect(code).not.toMatch(/\b(update|delete|truncate)\b/i);
  });

  it("runs in one transaction", () => {
    expect(code).toMatch(/^\s*begin;/m);
    expect(code).toMatch(/commit;\s*$/);
  });
});
