// Drift guard for migration 0146: the safety properties of the click tables must stay in the SQL file that production was built from.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
const sql = fs.readFileSync(path.join(dir, "0146_tracked_links.sql"), "utf8").replace(/^--.*$/gm, "");

describe("0146_tracked_links.sql", () => {
  it("turns row-level security on for both tables and revokes every grant (service role only)", () => {
    for (const t of ["tracked_links", "link_clicks"]) {
      expect(sql).toMatch(new RegExp(`alter table ${t} enable row level security`));
      expect(sql).toMatch(new RegExp(`revoke all on ${t} from public, anon, authenticated`));
    }
    expect(sql).not.toMatch(/create policy/i);
  });
  it("only lets service_role execute the two SECURITY DEFINER functions", () => {
    for (const fn of ["record_link_click\\(text, boolean\\)", "link_clicks_summary\\(uuid, timestamptz, text, text\\)"]) {
      expect(sql).toMatch(new RegExp(`revoke execute on function ${fn} from public, anon, authenticated`));
      expect(sql).toMatch(new RegExp(`grant execute on function ${fn} to service_role`));
    }
    expect((sql.match(/security definer/g) ?? []).length).toBe(2);
    expect((sql.match(/set search_path = public/g) ?? []).length).toBe(2);
  });
  it("pins the destination to https lazyrelay.com or timeajob.com in the database itself", () => {
    expect(sql).toContain("^https://(www\\.)?(lazyrelay|timeajob)\\.com(/[^[:space:]]*)?$");
  });
  it("stores nothing personal: no ip, user agent or cookie column", () => {
    const tables = sql.slice(sql.indexOf("create table tracked_links"), sql.indexOf("alter table tracked_links"));
    expect(tables).not.toMatch(/\bip\b|ip_address|user_agent|useragent|cookie|email|referer|referrer/i);
  });
  it("has no way to tell visitors apart: no visitor hash, unique flag or day-per-visitor index", () => {
    expect(sql).not.toMatch(/visitor|is_unique|unique_clicks|unique_tracked/i);
    expect(sql).toMatch(/where t\.account_id = p_account_id/);
  });
});
