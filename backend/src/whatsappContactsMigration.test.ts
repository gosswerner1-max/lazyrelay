// Static checks on migration 0128_whatsapp_contacts_consent.sql. The repo has NO SQL execution harness: these read the file
// as text. They prove the file says the right things (RLS on, grants, guards, column-level privilege); they do NOT prove the
// triggers or policies behave correctly in Postgres. That needs a run against a throwaway Supabase branch before applying.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
const name = fs.readdirSync(dir).find((f) => f.startsWith("0128_"));
const sql = name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
// Strip line comments so the header (which mentions grants in the ROLLBACK block) cannot satisfy or break a check.
const code = sql.replace(/^\s*--.*$/gm, "");
const TABLES = ["whatsapp_contacts", "whatsapp_opt_ins", "whatsapp_opt_outs"];

function tableBody(table: string): string {
  const m = code.match(new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!m) throw new Error(`table ${table} not found`);
  return m[1];
}

describe("migration 0128_whatsapp_contacts_consent", () => {
  it("exists with the expected name, one transaction, idempotent, with a rollback block", () => {
    expect(name).toBe("0128_whatsapp_contacts_consent.sql");
    expect(code).toMatch(/^\s*begin;/m);
    expect(code).toMatch(/commit;\s*$/);
    expect(sql).toMatch(/-- ROLLBACK/);
    expect(sql).toMatch(/NOT applied anywhere/i);
    for (const t of TABLES) expect(code).toContain(`create table if not exists ${t} (`);
  });

  it.each(TABLES)("%s: RLS on, member select policy, browser roles revoked, service role granted", (t) => {
    expect(code).toContain(`alter table ${t} enable row level security;`);
    expect(code).toContain(`drop policy if exists ${t}_select_members on ${t};`);
    expect(code).toMatch(new RegExp(`create policy ${t}_select_members on ${t} for select to authenticated using \\(is_account_member\\(account_id\\)\\);`));
    expect(code).toContain(`revoke all on ${t} from public, anon, authenticated;`);
    expect(code).toMatch(new RegExp(`grant [a-z, ]+ on ${t} to service_role;`));
    // no insert/update/delete policies: writes are service-role only
    expect(code).not.toMatch(new RegExp(`create policy \\w+ on ${t} for (insert|update|delete|all)`));
  });

  it("whatsapp_contacts: authenticated gets a COLUMN-level select that excludes phone_ciphertext, and never select *", () => {
    const grant = code.match(/grant select \(([^)]*)\) on whatsapp_contacts to authenticated;/);
    expect(grant).not.toBeNull();
    const granted = grant![1].split(",").map((c) => c.trim()).filter(Boolean);
    const defined = tableBody("whatsapp_contacts")
      .split("\n")
      .map((l) => l.trim().match(/^([a-z_]+) (uuid|text|timestamptz|boolean|integer)\b/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => m[1]);
    expect(defined).toContain("phone_ciphertext");
    expect(granted).not.toContain("phone_ciphertext");
    expect(granted.sort()).toEqual(defined.filter((c) => c !== "phone_ciphertext").sort());
    expect(code).not.toMatch(/grant select on whatsapp_contacts to authenticated/);
    expect(code).not.toMatch(/grant (all|insert|update|delete)[^;]* on whatsapp_\w+ to (authenticated|anon|public)/);
  });

  it("whatsapp_contacts: required columns and checks", () => {
    const body = tableBody("whatsapp_contacts");
    for (const col of ["contact_key", "wa_contact_key", "contact_display", "phone_ciphertext", "country_calling_code", "display_name", "consent_status", "opted_in_at", "opted_out_at", "current_opt_in_id"]) {
      expect(body).toContain(col);
    }
    expect(body).toMatch(/contact_key text not null/);
    expect(body).toMatch(/contact_key ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(body).toMatch(/wa_contact_key is null or wa_contact_key ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(body).toMatch(/consent_status in \('opted_in', 'opted_out'\)/);
    expect(body).toMatch(/\[0-9\]\{7\}/); // masked display, same rule as 0127
    expect(body).toMatch(/phone_ciphertext is null or/);
    expect(body).toMatch(/char_length\(phone_ciphertext\) <= \d+/);
    expect(body).toMatch(/char_length\(display_name\) <= 80/);
    expect(body).toMatch(/unique \(social_account_id, contact_key\)/);
  });

  it("whatsapp_opt_ins: consent evidence columns, source list, attestation, hash chain", () => {
    const body = tableBody("whatsapp_opt_ins");
    expect(body).toMatch(/source in \('customer_import', 'website_form', 'whatsapp_inbound', 'click_to_whatsapp_ad', 'in_person', 'phone_call', 'qr_code', 'other'\)/);
    expect(body).toMatch(/attested boolean not null/);
    expect(body).toMatch(/check \(attested\)/);
    expect(body).toMatch(/consent_text text not null/);
    expect(body).toMatch(/char_length\(consent_text\) between 1 and 1000/);
    expect(body).toMatch(/char_length\(proof_reference\) <= 500/);
    expect(body).toMatch(/captured_at <= recorded_at/);
    for (const col of ["captured_at", "recorded_at", "recorded_by", "attestation_version", "import_batch_id", "prev_hash", "row_hash"]) expect(body).toContain(col);
    expect(body).toMatch(/row_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(code).toMatch(/unique \(contact_id, prev_hash\)|on whatsapp_opt_ins \(contact_id, prev_hash\)/);
  });

  it("whatsapp_opt_ins is append-only: no update/delete grant to anyone, guard trigger on update, delete and truncate", () => {
    expect(code).toMatch(/grant select, insert on whatsapp_opt_ins to service_role;/);
    expect(code).not.toMatch(/grant [^;]*(update|delete|truncate|all)[^;]* on whatsapp_opt_ins to/);
    expect(code).toMatch(/create trigger whatsapp_opt_ins_append_only\s+before update or delete on whatsapp_opt_ins\s+for each row/);
    expect(code).toMatch(/before truncate on whatsapp_opt_ins\s+for each statement/);
    expect(code).toMatch(/raise exception 'whatsapp_opt_ins is append-only/);
  });

  it("whatsapp_opt_outs: hash-only suppression list with no link to a contact row and no update/delete", () => {
    const body = tableBody("whatsapp_opt_outs");
    expect(body).toMatch(/scope text not null[^\n]*check|scope in \('all', 'marketing'\)/);
    expect(body).toMatch(/scope in \('all', 'marketing'\)/);
    expect(body).toMatch(/source in \('keyword', 'meta_131050', 'manual', 'import_row'\)/);
    expect(body).toMatch(/unique \(account_id, contact_key, scope\)/);
    for (const col of ["contact_key", "contact_display", "wa_contact_key", "keyword", "occurred_at"]) expect(body).toContain(col);
    expect(body).not.toMatch(/references whatsapp_contacts/);
    expect(body).not.toMatch(/phone_ciphertext|contact_id|display_name/);
    expect(code).toMatch(/grant select, insert on whatsapp_opt_outs to service_role;/);
    expect(code).not.toMatch(/grant [^;]*(update|delete|truncate|all)[^;]* on whatsapp_opt_outs to/);
  });

  it("opt-out triggers exist and are security definer with a pinned search_path and no public execute", () => {
    expect(code).toMatch(/create trigger whatsapp_opt_outs_apply\s+after insert on whatsapp_opt_outs/);
    expect(code).toMatch(/create trigger whatsapp_contacts_enforce_opt_out\s+before insert or update on whatsapp_contacts/);
    for (const fn of ["whatsapp_opt_outs_apply", "whatsapp_contacts_enforce_opt_out", "whatsapp_opt_ins_append_only"]) {
      const m = code.match(new RegExp(`create or replace function ${fn}\\(\\)([\\s\\S]*?)\\$\\$;`));
      expect(m, fn).not.toBeNull();
      expect(m![1]).toMatch(/security definer/);
      expect(m![1]).toMatch(/set search_path = public, pg_temp/);
      expect(code).toContain(`revoke execute on function ${fn}() from public, anon, authenticated;`);
    }
  });

  it("does not touch purge_stored_messages and uses no destructive statements outside the guarded table definitions", () => {
    expect(code).not.toMatch(/purge_stored_messages/);
    expect(code).not.toMatch(/\bdrop table\b/);
    expect(code).not.toMatch(/\btruncate table\b/);
  });
});
