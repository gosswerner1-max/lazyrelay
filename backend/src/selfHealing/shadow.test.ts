// The shadow recorder (shadow.ts) and migration 0136 (the table it writes). The repo has NO SQL execution harness: the migration
// checks read the file as text and do not prove behaviour in Postgres (apply to a throwaway Supabase branch first).

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeShadowEvent, shadowDiverged, SHADOW_SOURCES, SHADOW_ERROR_CLASSES, SHADOW_ACTIONS, SHADOW_REASON_CODES, type ShadowEvent } from "./shadow.js";

vi.mock("../supabase.js", () => ({ supabase: { from: () => { throw new Error("the real client must not be used in this test"); } } }));

afterEach(() => vi.restoreAllMocks());

const event: ShadowEvent = {
  source: "post",
  postId: "11111111-1111-4111-8111-111111111111",
  socialAccountId: "22222222-2222-4222-8222-222222222222",
  platform: "bluesky",
  errorClass: "transient",
  legacyAction: "retry",
  legacyDelayMs: 240_000,
  newAction: "retry",
  newDelayMs: 310_000,
  newReasonCode: null,
  latenessMs: 60_000,
  wouldAlert: false,
  diverged: true,
};

describe("writeShadowEvent", () => {
  it("inserts one row holding only ids, labels, numbers and fixed codes", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const db = { from: vi.fn(() => ({ insert })) };
    await writeShadowEvent(db as never, event, "shadow");
    expect(db.from).toHaveBeenCalledWith("self_healing_shadow_events");
    expect(insert).toHaveBeenCalledTimes(1);
    const row = (insert.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(row).toEqual({
      mode: "shadow",
      source: "post",
      post_id: event.postId,
      social_account_id: event.socialAccountId,
      platform: "bluesky",
      error_class: "transient",
      legacy_action: "retry",
      legacy_delay_ms: 240_000,
      new_action: "retry",
      new_delay_ms: 310_000,
      new_reason_code: null,
      lateness_ms: 60_000,
      would_alert: false,
      diverged: true,
    });
  });

  it("logs a failed insert with the fixed tag and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = { from: () => ({ insert: async () => ({ error: { code: "42P01", message: "relation does not exist" } }) }) };
    await expect(writeShadowEvent(db as never, event, "shadow")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[self-healing-shadow] insert failed", "42P01");
  });

  it("logs and does not throw when the insert itself throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = { from: () => ({ insert: async () => { throw new Error("socket closed"); } }) };
    await expect(writeShadowEvent(db as never, event, "shadow")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[self-healing-shadow] insert failed", "threw");
  });

  it("does not throw when the client cannot even be asked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = { from: () => { throw new Error("no client"); } };
    await expect(writeShadowEvent(db as never, event, "shadow")).resolves.toBeUndefined();
  });
});

describe("shadowDiverged", () => {
  it("is false when action, reason and the base delay agree", () => {
    expect(shadowDiverged({ legacyAction: "retry", legacyDelayMs: 120_000, newAction: "retry", newBaseDelayMs: 120_000 })).toBe(false);
  });
  it("is true when the action differs", () => {
    expect(shadowDiverged({ legacyAction: "retry", newAction: "fail", newReasonCode: "too_late" })).toBe(true);
  });
  it("is true when the base delay differs (jitter alone does not count)", () => {
    expect(shadowDiverged({ legacyAction: "retry", legacyDelayMs: 240_000, newAction: "retry", newBaseDelayMs: 300_000 })).toBe(true);
  });
  it("is true when the reason code differs", () => {
    expect(shadowDiverged({ legacyAction: "fail", legacyReasonCode: "fatal", newAction: "fail", newReasonCode: "retries_exhausted" })).toBe(true);
  });
});

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");
const name = fs.readdirSync(dir).find((f) => f.startsWith("0136_"));
const sql = name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
const code = sql.replace(/^\s*--.*$/gm, "").replace(/\s+/g, " ").toLowerCase().trim();

function listIn(column: string): string[] {
  const m = new RegExp(`${column} text[^,]*check \\(${column} in \\(([^)]*)\\)\\)`).exec(code);
  if (!m) throw new Error(`no check list for ${column}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

describe("migration 0136_self_healing_shadow_events", () => {
  it("exists, is one transaction, idempotent, marked not applied and has a rollback", () => {
    expect(name).toBe("0136_self_healing_shadow_events.sql");
    expect(sql).toMatch(/NOT applied anywhere/i);
    expect(sql).toMatch(/-- ROLLBACK/);
    expect(code).toMatch(/^begin;/);
    expect(code).toMatch(/commit;$/);
    expect(code).toContain("create table if not exists public.self_healing_shadow_events");
    expect(code).toContain("create index if not exists");
  });

  it("holds exactly the agreed columns and no content, token or error text", () => {
    const body = code.slice(code.indexOf("create table"), code.indexOf(");", code.indexOf("create table")));
    for (const col of ["post_id uuid", "social_account_id uuid", "platform text not null", "error_class text", "legacy_action text not null", "legacy_delay_ms bigint", "new_action text not null", "new_delay_ms bigint", "new_reason_code text", "diverged boolean not null", "mode text not null", "created_at timestamptz not null default now()"]) {
      expect(body).toContain(col);
    }
    expect(body).not.toMatch(/content|token|secret|message|body|payload|raw|email/);
  });

  it("has no foreign keys, so history survives a deleted post, account or connection", () => {
    expect(code).not.toMatch(/references/);
  });

  it("its check lists are exactly the lists the code uses", () => {
    expect(listIn("source")).toEqual([...SHADOW_SOURCES]);
    expect(listIn("error_class")).toEqual([...SHADOW_ERROR_CLASSES]);
    expect(listIn("legacy_action")).toEqual([...SHADOW_ACTIONS]);
    expect(listIn("new_action")).toEqual([...SHADOW_ACTIONS]);
    expect(listIn("new_reason_code")).toEqual([...SHADOW_REASON_CODES]);
    expect(listIn("mode")).toEqual(["shadow", "on"]);
  });

  it("is service only: RLS on with no policy, browser roles revoked, service role granted", () => {
    expect(code).toContain("alter table public.self_healing_shadow_events enable row level security");
    expect(code).not.toMatch(/create policy/);
    expect(code).toContain("revoke all on public.self_healing_shadow_events from public, anon, authenticated");
    expect(code).toContain("grant all on public.self_healing_shadow_events to service_role");
    expect(code).not.toMatch(/grant [^;]* to (anon|authenticated)/);
  });
});
