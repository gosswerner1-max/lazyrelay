// System audit rows for connection transitions (audit.ts) and migration 0137. The repo has NO SQL execution harness: the migration
// checks read the file as text and do not prove behaviour in Postgres (apply to a throwaway Supabase branch first).

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordSystemCredentialTransition, authReasonFromText, AUDIT_REASON_CODES } from "./audit.js";

vi.mock("../supabase.js", () => ({ supabase: { rpc: () => { throw new Error("the real client must not be used in this test"); } } }));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SELF_HEALING_MODE;
});

const base = { accountId: "acc1", socialAccountId: "sa1", platform: "bluesky", action: "rejected" as const, reasonCode: "revoked" as const };

describe("recordSystemCredentialTransition", () => {
  it("writes nothing while the mode is off (the default)", async () => {
    const rpc = vi.fn(async () => ({ error: null }));
    await recordSystemCredentialTransition({ db: { rpc } as never, ...base });
    process.env.SELF_HEALING_MODE = "ON";
    await recordSystemCredentialTransition({ db: { rpc } as never, ...base });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["shadow", "on"])("writes one system row through the single-statement function in %s mode, with ids and labels only", async (mode) => {
    process.env.SELF_HEALING_MODE = mode;
    const rpc = vi.fn(async () => ({ error: null }));
    await recordSystemCredentialTransition({ db: { rpc } as never, ...base });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_system_credential_audit", { p_account_id: "acc1", p_social_account_id: "sa1", p_platform: "bluesky", p_action: "rejected", p_reason_code: "revoked" });
  });

  it("a recovered row carries no reason code", async () => {
    process.env.SELF_HEALING_MODE = "on";
    const rpc = vi.fn(async () => ({ error: null }));
    await recordSystemCredentialTransition({ db: { rpc } as never, accountId: "acc1", socialAccountId: "sa1", platform: "x", action: "recovered", reasonCode: "revoked" });
    expect(rpc).toHaveBeenCalledWith("record_system_credential_audit", expect.objectContaining({ p_action: "recovered", p_reason_code: null }));
  });

  it("a reason code outside the fixed list is dropped, never stored", async () => {
    process.env.SELF_HEALING_MODE = "on";
    const rpc = vi.fn(async () => ({ error: null }));
    await recordSystemCredentialTransition({ db: { rpc } as never, ...base, reasonCode: "ECONNRESET" as never });
    expect(rpc).toHaveBeenCalledWith("record_system_credential_audit", expect.objectContaining({ p_reason_code: null }));
  });

  it("does nothing without a connection id", async () => {
    process.env.SELF_HEALING_MODE = "on";
    const rpc = vi.fn(async () => ({ error: null }));
    await recordSystemCredentialTransition({ db: { rpc } as never, ...base, socialAccountId: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("logs a failed call with the fixed tag and never throws", async () => {
    process.env.SELF_HEALING_MODE = "on";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async () => ({ error: { code: "42883", message: "function does not exist" } }));
    await expect(recordSystemCredentialTransition({ db: { rpc } as never, ...base })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith("[credential-audit] system transition failed", "42883");
  });

  it("never throws when the call itself throws", async () => {
    process.env.SELF_HEALING_MODE = "on";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async () => { throw new Error("socket closed"); });
    await expect(recordSystemCredentialTransition({ db: { rpc } as never, ...base })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith("[credential-audit] system transition failed", "threw");
  });
});

describe("authReasonFromText", () => {
  it.each([
    ["Missing permission: pages_manage_posts", "insufficient_permission"],
    ["The platform rejected the saved login (it was revoked or has expired).", "revoked"],
    ["session has been invalidated", "revoked"],
    ["The linkedin connection expired on 2026-10-01.", "expired"],
    ["Token has expired", "expired"],
    ["The platform rejected the saved login.", "invalid_token"],
    ["", "invalid_token"],
  ])("%s -> %s", (text, code) => {
    expect(authReasonFromText(text)).toBe(code);
  });
  it("only ever returns a code from the fixed list", () => {
    for (const t of ["a", "permission", "revoked", "expired"]) expect(AUDIT_REASON_CODES).toContain(authReasonFromText(t));
  });
});

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");
const name = fs.readdirSync(dir).find((f) => f.startsWith("0137_"));
const sql = name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
const code = sql.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ").toLowerCase().trim();

describe("migration 0137_credential_audit_transitions", () => {
  it("exists, is one transaction, idempotent, marked not applied and has a rollback", () => {
    expect(name).toBe("0137_credential_audit_transitions.sql");
    expect(sql).toMatch(/NOT applied anywhere/i);
    expect(sql).toMatch(/-- ROLLBACK/);
    expect(code).toMatch(/^begin;/);
    expect(code).toMatch(/commit;$/);
  });

  it("drops and re-adds the action check with the two new values and keeps the four old ones", () => {
    expect(code).toContain("alter table public.credential_audit_events drop constraint if exists credential_audit_events_action_check");
    expect(code).toContain("add constraint credential_audit_events_action_check check (action in ('saved', 'replaced', 'cleared', 'app_secret_cleared', 'rejected', 'recovered'))");
  });

  it("adds a nullable reason_code with a check against the fixed list", () => {
    expect(code).toContain("add column if not exists reason_code text");
    expect(code).toContain("drop constraint if exists credential_audit_events_reason_code_check");
    const m = /credential_audit_events_reason_code_check check \(reason_code is null or reason_code in \(([^)]*)\)\)/.exec(code);
    expect(m).not.toBeNull();
    expect([...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toEqual([...AUDIT_REASON_CODES]);
  });

  it("does not touch actor_role or actor_user_id, which are already nullable and unchecked", () => {
    expect(code).not.toMatch(/alter column actor_/);
    expect(code).not.toMatch(/actor_role in/);
  });

  it("dedupes in ONE statement: insert ... select ... where not exists, per connection and action, over 24 hours", () => {
    expect(code).toContain("create or replace function public.record_system_credential_audit(");
    expect(code).toMatch(/insert into public\.credential_audit_events \([^)]*\) select [^;]* where not exists \( select 1 from public\.credential_audit_events e where e\.social_account_id = p_social_account_id and e\.action = p_action and e\.created_at > now\(\) - interval '24 hours' \);/);
    expect(code.match(/insert into public\.credential_audit_events/g)).toHaveLength(1);
  });

  it("writes a system row: null actor user, actor role system, and only the two system actions are accepted", () => {
    expect(code).toMatch(/select p_account_id, p_social_account_id, p_platform, p_action, null, 'system', p_reason_code/);
    expect(code).toMatch(/if p_action not in \('rejected', 'recovered'\) then/);
  });

  it("serialises two writers for the same connection and action", () => {
    expect(code).toContain("pg_advisory_xact_lock(");
  });

  it("is callable by the backend only", () => {
    expect(code).toMatch(/revoke all on function public\.record_system_credential_audit\([^)]*\) from public, anon, authenticated;/);
    expect(code).toMatch(/grant execute on function public\.record_system_credential_audit\([^)]*\) to service_role;/);
    expect(code).not.toMatch(/grant [^;]* to (anon|authenticated)/);
  });

  it("stores no secret, token, key or message text", () => {
    expect(code).not.toMatch(/token text|secret text|body text|message text|payload/);
  });
});
