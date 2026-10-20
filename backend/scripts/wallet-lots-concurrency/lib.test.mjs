import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chainProblem, checkGuard, localizeSql, scrub, tallyTerminal } from "./lib.mjs";

const URL_OK = "postgres://postgres:secret-pass@db.abcd.supabase.co:5432/postgres";
const YES = "yes";

describe("the guard refuses to run against anything that is not a declared throwaway branch", () => {
  it("refuses when the connection string is missing or empty", () => {
    expect(checkGuard({}).ok).toBe(false);
    expect(checkGuard({ WALLET_CONCURRENCY_DATABASE_URL: "  ", WALLET_CONCURRENCY_I_AM_A_THROWAWAY_BRANCH: YES }).ok).toBe(false);
  });

  it("refuses without the explicit throwaway flag, whatever its near spelling", () => {
    for (const flag of [undefined, "", "YES", "true", "1", "yes "]) {
      const r = checkGuard({ WALLET_CONCURRENCY_DATABASE_URL: URL_OK, WALLET_CONCURRENCY_I_AM_A_THROWAWAY_BRANCH: flag });
      expect(r.ok, String(flag)).toBe(false);
    }
  });

  it("refuses a host that looks like production and a host on the forbidden list", () => {
    const prod = checkGuard({ WALLET_CONCURRENCY_DATABASE_URL: "postgres://u:p@db.prod-main.example.com/postgres", WALLET_CONCURRENCY_I_AM_A_THROWAWAY_BRANCH: YES });
    expect(prod.ok).toBe(false);
    const listed = checkGuard({ WALLET_CONCURRENCY_DATABASE_URL: URL_OK, WALLET_CONCURRENCY_I_AM_A_THROWAWAY_BRANCH: YES, WALLET_CONCURRENCY_FORBIDDEN_HOSTS: "other.example.com, db.abcd.supabase.co" });
    expect(listed.ok).toBe(false);
  });

  it("refuses a string that is not a postgres URL", () => {
    expect(checkGuard({ WALLET_CONCURRENCY_DATABASE_URL: "mysql://u:p@h/db", WALLET_CONCURRENCY_I_AM_A_THROWAWAY_BRANCH: YES }).ok).toBe(false);
    expect(checkGuard({ WALLET_CONCURRENCY_DATABASE_URL: "not a url", WALLET_CONCURRENCY_I_AM_A_THROWAWAY_BRANCH: YES }).ok).toBe(false);
  });

  it("accepts a declared throwaway branch and never repeats the connection string in its answer", () => {
    const r = checkGuard({ WALLET_CONCURRENCY_DATABASE_URL: URL_OK, WALLET_CONCURRENCY_I_AM_A_THROWAWAY_BRANCH: YES });
    expect(r.ok).toBe(true);
    expect(r.url).toBe(URL_OK);
    expect(JSON.stringify({ ...r, url: undefined })).not.toContain("secret-pass");
  });

  it("the refusal messages never contain the connection string", () => {
    const r = checkGuard({ WALLET_CONCURRENCY_DATABASE_URL: URL_OK });
    expect(r.ok).toBe(false);
    expect(r.reason).not.toContain("secret-pass");
    expect(r.reason).not.toContain("supabase.co");
  });
});

describe("scrub", () => {
  it("removes the connection string, its password and its host from any text", () => {
    const text = `connect ECONNREFUSED db.abcd.supabase.co:5432 for ${URL_OK} using secret-pass`;
    const out = scrub(text, [URL_OK]);
    expect(out).not.toContain("secret-pass");
    expect(out).not.toContain("db.abcd.supabase.co");
    expect(out).not.toContain("postgres://");
  });
});

describe("localizeSql moves a migration into the fixture schema", () => {
  const fx = "wl_cc_0123456789ab";
  it("rewrites every public. reference and the pinned search_path, and nothing else", () => {
    const out = localizeSql("create table public.t (a int); create function public.f() returns int language sql set search_path = public, pg_temp as $$ select 1 $$;", fx);
    expect(out).toBe(`create table ${fx}.t (a int); create function ${fx}.f() returns int language sql set search_path = ${fx}, pg_temp as $$ select 1 $$;`);
  });

  it("leaves no public. and no public search_path in the real migrations", () => {
    for (const f of ["0139_wallet_ledger.sql", "0140_wallet_credit_lots.sql"]) {
      const sql = readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), "utf8");
      const out = localizeSql(sql, fx);
      expect(out, f).not.toMatch(/\bpublic\./);
      expect(out, f).not.toMatch(/search_path\s*=\s*public/);
      expect(out, f).toContain(`${fx}.wallet_`);
    }
  });

  it("refuses a schema name that is not our own prefix", () => {
    expect(() => localizeSql("select 1", "public")).toThrow();
    expect(() => localizeSql("select 1", "wl_cc_x; drop schema public")).toThrow();
  });
});

describe("chainProblem finds a broken ledger", () => {
  const ok = [{ d: 10, b: 10, parts: 10 }, { d: -4, b: 6, parts: 4 }, { d: -6, b: 0, parts: 6 }];
  it("accepts a consistent chain and an empty one", () => {
    expect(chainProblem(ok, 0)).toBeNull();
    expect(chainProblem([], 0)).toBeNull();
  });
  it("finds a wrong running balance, a negative balance, a wrong breakdown and a wrong end balance", () => {
    expect(chainProblem([{ d: 10, b: 11, parts: 10 }], 11)).toMatch(/chain/);
    expect(chainProblem([{ d: -1, b: -1, parts: 1 }], -1)).toMatch(/negative|chain/);
    expect(chainProblem([{ d: 10, b: 10, parts: 9 }], 10)).toMatch(/breakdown/);
    expect(chainProblem(ok, 5)).toMatch(/end/);
  });
});

describe("tallyTerminal decides who won a commit and release race", () => {
  it("commit won: one real commit, every release refused", () => {
    const r = tallyTerminal({ commits: [{ ok: true, replay: false }, { ok: true, replay: true }], releases: [{ ok: false, reason: "hold_not_held" }], status: "committed", commitEntries: 1 });
    expect(r).toEqual({ ok: true, winner: "commit" });
  });
  it("release won: one real release, every commit refused, no ledger entry", () => {
    const r = tallyTerminal({ commits: [{ ok: false, reason: "hold_not_held" }], releases: [{ ok: true, replay: false }, { ok: true, replay: true }], status: "released", commitEntries: 0 });
    expect(r).toEqual({ ok: true, winner: "release" });
  });
  it("fails when both sides think they won, when two real commits happened or when the entry count is wrong", () => {
    expect(tallyTerminal({ commits: [{ ok: true, replay: false }], releases: [{ ok: true, replay: false }], status: "committed", commitEntries: 1 }).ok).toBe(false);
    expect(tallyTerminal({ commits: [{ ok: true, replay: false }, { ok: true, replay: false }], releases: [], status: "committed", commitEntries: 1 }).ok).toBe(false);
    expect(tallyTerminal({ commits: [{ ok: true, replay: false }], releases: [{ ok: false, reason: "hold_not_held" }], status: "committed", commitEntries: 2 }).ok).toBe(false);
  });
});

import { classifyByExpiry, leadMs, median, raceExercised } from "./lib.mjs";

describe("timing helpers of the expiry race check", () => {
  it("median of an odd and an even list, and of nothing", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("the lead is the larger of 4 seconds and 25 round trips, and grows with every retry", () => {
    expect(leadMs(10, 0)).toBe(4000);
    expect(leadMs(200, 0)).toBe(5000);
    expect(leadMs(400, 0)).toBe(10000);
    expect(leadMs(10, 1)).toBe(8000);
    expect(leadMs(10, 2)).toBe(12000);
  });

  it("classifies each operation by its database timestamp, not by the client clock", () => {
    const expiry = new Date("2026-11-01T10:00:10.000Z");
    const ops = [
      { t: new Date("2026-11-01T10:00:09.999Z") },
      { t: new Date("2026-11-01T10:00:10.000Z") },
      { t: new Date("2026-11-01T10:00:12.000Z") },
      { t: null },
    ];
    expect(classifyByExpiry(ops, expiry)).toEqual({ before: 1, after: 2, unstamped: 1 });
  });

  it("the race window counts as exercised only with at least 20 operations on each side", () => {
    expect(raceExercised({ before: 20, after: 20 })).toBe(true);
    expect(raceExercised({ before: 19, after: 50 })).toBe(false);
    expect(raceExercised({ before: 50, after: 19 })).toBe(false);
    expect(raceExercised({ before: 0, after: 8 })).toBe(false);
  });
});
