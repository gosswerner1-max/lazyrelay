// Static checks on migration 0134_social_accounts_client_write_lockdown.sql. The repo has NO SQL execution harness: these read the file
// as text. They prove the file says the right things (INSERT and UPDATE are taken from `authenticated`, then UPDATE is given back on
// exactly the three columns the dashboard writes, nothing else is touched);
// they do NOT prove the grant state in Postgres. Verify with has_table_privilege on a throwaway Supabase branch before applying.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
const name = fs.readdirSync(dir).find((f) => f.startsWith("0134_"));
const sql = name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
const code = sql.replace(/^\s*--.*$/gm, "");
const statements = code
  .split(";")
  .map((s) => s.trim().replace(/\s+/g, " ").toLowerCase())
  .filter((s) => s && s !== "begin" && s !== "commit");

describe("migration 0134_social_accounts_client_write_lockdown", () => {
  it("exists with the expected name, marked not applied, with a rollback", () => {
    expect(name).toBe("0134_social_accounts_client_write_lockdown.sql");
    expect(sql).toMatch(/NOT applied/i);
    expect(sql).toMatch(/ROLLBACK/);
    expect(sql).toContain("grant insert, update on public.social_accounts to authenticated;");
  });

  it("revokes INSERT and UPDATE from authenticated, then grants UPDATE on exactly brand_id, brand_label, disconnected_at, and nothing else", () => {
    expect(statements).toEqual([
      "revoke insert, update on public.social_accounts from authenticated",
      "grant update (brand_id, brand_label, disconnected_at) on public.social_accounts to authenticated",
    ]);
  });

  it("does not touch SELECT, DELETE, anon, the service role or the RLS policies", () => {
    expect(code).not.toMatch(/\b(select|delete|truncate|references|trigger|all)\b/i);
    expect(code).not.toMatch(/\b(anon|service_role|public\b(?!\.social_accounts)|policy|row level security)\b/i);
  });
});
