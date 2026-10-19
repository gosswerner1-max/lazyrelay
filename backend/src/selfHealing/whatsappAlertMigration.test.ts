// Static checks on migration 0138 (the column that keeps the 6 hour cooldown of the WhatsApp trouble digest). The repo has NO SQL
// execution harness: these read the file as text and do not prove behaviour in Postgres.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");
const name = fs.readdirSync(dir).find((f) => f.startsWith("0138_"));
const sql = name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
const code = sql.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ").toLowerCase().trim();

describe("migration 0138_social_accounts_whatsapp_fault_alert", () => {
  it("exists, is one transaction, idempotent, marked not applied and has a rollback", () => {
    expect(name).toBe("0138_social_accounts_whatsapp_fault_alert.sql");
    expect(sql).toMatch(/NOT applied anywhere/i);
    expect(sql).toMatch(/-- ROLLBACK/);
    expect(code).toMatch(/^begin;/);
    expect(code).toMatch(/commit;$/);
  });

  it("adds exactly one nullable timestamptz column with no default", () => {
    expect(code).toBe("begin; alter table public.social_accounts add column if not exists whatsapp_fault_alert_sent_at timestamptz; commit;");
  });

  it("grants nothing, so the browser-facing role cannot write the column (0134 limits it to three other columns)", () => {
    expect(code).not.toMatch(/grant /);
  });

  it("0134 still grants the browser role update on only its three columns, none of them this one", () => {
    const lockdown = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith("0134_"))!), "utf8");
    expect(lockdown).toMatch(/grant update \(brand_id, brand_label, disconnected_at\) on public\.social_accounts to authenticated;/);
    expect(lockdown).not.toMatch(/whatsapp_fault_alert_sent_at/);
  });
});
