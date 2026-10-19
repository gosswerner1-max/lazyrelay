// The credential audit trail: the helper that writes one row per credential change, and static checks on migration 0135.
// The repo has NO SQL execution harness: the migration checks read the file as text and do not prove the grant state in
// Postgres (verify with has_table_privilege on a throwaway Supabase branch before applying).

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordCredentialAudit } from "./credentialAudit.js";

const base = { accountId: "acc1", socialAccountId: "sa1", platform: "x", action: "saved" as const, actorUserId: "u1", actorRole: "member" };

afterEach(() => vi.restoreAllMocks());

describe("recordCredentialAudit", () => {
  it("inserts exactly one row with only ids and labels", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const supabase = { from: vi.fn(() => ({ insert })) };
    await recordCredentialAudit({ supabase: supabase as never, ...base });
    expect(supabase.from).toHaveBeenCalledWith("credential_audit_events");
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({ account_id: "acc1", social_account_id: "sa1", platform: "x", action: "saved", actor_user_id: "u1", actor_role: "member" });
  });

  it("logs a failed insert with the tag, code and message, and does not throw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = { from: () => ({ insert: async () => ({ error: { code: "42501", message: "denied" } }) }) };
    await expect(recordCredentialAudit({ supabase: supabase as never, ...base })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith("[credential-audit] insert failed", "42501", "denied");
  });

  it("logs and does not throw when the insert itself throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = { from: () => ({ insert: async () => { throw new Error("socket closed"); } }) };
    await expect(recordCredentialAudit({ supabase: supabase as never, ...base })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith("[credential-audit] insert failed", undefined, "socket closed");
  });
});

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
const name = fs.readdirSync(dir).find((f) => f.startsWith("0135_"));
const sql = name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
const code = sql.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ").toLowerCase();

describe("migration 0135_credential_audit_events", () => {
  it("exists, is marked not applied and has a rollback", () => {
    expect(name).toBe("0135_credential_audit_events.sql");
    expect(sql).toMatch(/NOT applied/i);
    expect(sql).toMatch(/ROLLBACK/);
  });

  it("creates the table with the agreed columns and the action check", () => {
    expect(code).toContain("create table if not exists public.credential_audit_events");
    for (const col of ["id uuid primary key default gen_random_uuid()", "account_id uuid not null references public.accounts", "social_account_id uuid", "platform text not null", "actor_user_id uuid", "actor_role text", "created_at timestamptz not null default now()"]) {
      expect(code).toContain(col);
    }
    expect(code).toMatch(/action text not null check \(action in \('saved', 'replaced', 'cleared', 'app_secret_cleared'\)\)/);
    expect(code).toContain("on public.credential_audit_events (account_id, created_at desc)");
  });

  it("stores no secret, token, hint or body", () => {
    const table = code.slice(code.indexOf("create table"), code.indexOf(");", code.indexOf("create table"))).replace("'app_secret_cleared'", ""); // the action value names the event, it holds no secret
    expect(table).not.toMatch(/secret|token|hint|body|payload/);
  });

  it("enables RLS with one member SELECT policy and no insert/update/delete policy", () => {
    expect(code).toContain("alter table public.credential_audit_events enable row level security");
    expect(code.match(/create policy/g)).toHaveLength(1);
    expect(code).toMatch(/create policy \w+ on public\.credential_audit_events for select to authenticated using \(is_account_member\(account_id\)\)/);
    expect(code).not.toMatch(/for (insert|update|delete|all)/);
  });

  it("takes everything from anon and authenticated, then grants only select to authenticated", () => {
    expect(code).toContain("revoke all on public.credential_audit_events from anon, authenticated");
    expect(code).toContain("grant select on public.credential_audit_events to authenticated");
    expect(code).not.toMatch(/grant (insert|update|delete|all)[^;]* to (anon|authenticated)/);
  });
});
