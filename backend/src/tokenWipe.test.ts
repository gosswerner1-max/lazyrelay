// Wiping stored platform logins: the Vault secret is overwritten (never just hidden), only the right rows are touched,
// a failure is retried by the sweep, and nothing here can reach a real database.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables, vault, makeBuilder, fakeRpc } from "./testFakeSupabase.js";
import { wipeVaultSecrets, wipeConnectionTokens, sweepDisconnectedTokens, WIPED_TOKEN_MARKER } from "./tokenWipe.js";

const failFor = new Set<string>();
const db = {
  from: (t: string) => makeBuilder(t),
  rpc: async (fn: string, args: Record<string, unknown>) =>
    fn === "update_social_token" && failFor.has(args.p_vault_id as string) ? { data: null, error: { message: "vault unavailable" } } : fakeRpc(fn, args),
} as never;

function seedLogin(id: string, access: string, refresh: string | null) {
  vault.set(`${id}-a`, access);
  if (refresh) vault.set(`${id}-r`, refresh);
  return { access_token_vault_id: `${id}-a`, refresh_token_vault_id: refresh ? `${id}-r` : null };
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  failFor.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("wipeVaultSecrets", () => {
  it("overwrites each secret with the marker, so the real token is gone", async () => {
    vault.set("v1", "real-access-token");
    vault.set("v2", "real-refresh-token");
    const r = await wipeVaultSecrets(db, ["v1", "v2"]);
    expect(r).toEqual({ wiped: 2, failed: 0 });
    expect(vault.get("v1")).toBe(WIPED_TOKEN_MARKER);
    expect(vault.get("v2")).toBe(WIPED_TOKEN_MARKER);
    expect([...vault.values()].some((v) => v.includes("real-"))).toBe(false);
  });

  it("ignores empty ids and counts a repeated id once", async () => {
    vault.set("v1", "t");
    const r = await wipeVaultSecrets(db, [null, undefined, "", "v1", "v1"]);
    expect(r).toEqual({ wiped: 1, failed: 0 });
  });

  it("counts a failure instead of throwing, and leaves that secret alone", async () => {
    vault.set("v1", "keep-me");
    vault.set("v2", "t2");
    failFor.add("v1");
    const r = await wipeVaultSecrets(db, ["v1", "v2"]);
    expect(r).toEqual({ wiped: 1, failed: 1 });
    expect(vault.get("v1")).toBe("keep-me");
    expect(vault.get("v2")).toBe(WIPED_TOKEN_MARKER);
  });
});

describe("wipeConnectionTokens", () => {
  it("wipes both the access and refresh login of one account and records it", async () => {
    tables.social_accounts = [
      { id: "sa1", account_id: "acc1", ...seedLogin("one", "ACCESS-ONE", "REFRESH-ONE"), tokens_wiped_at: null },
      { id: "sa2", account_id: "acc1", ...seedLogin("two", "ACCESS-TWO", "REFRESH-TWO"), tokens_wiped_at: null },
    ];
    const ok = await wipeConnectionTokens(db, "social_accounts", "id", "sa1");
    expect(ok).toBe(true);
    expect(vault.get("one-a")).toBe(WIPED_TOKEN_MARKER);
    expect(vault.get("one-r")).toBe(WIPED_TOKEN_MARKER);
    expect(tables.social_accounts[0].tokens_wiped_at).toBeTruthy();
    // the other account is untouched
    expect(vault.get("two-a")).toBe("ACCESS-TWO");
    expect(vault.get("two-r")).toBe("REFRESH-TWO");
    expect(tables.social_accounts[1].tokens_wiped_at).toBeNull();
  });

  it("handles an account with no refresh login", async () => {
    tables.social_accounts = [{ id: "sa1", account_id: "acc1", ...seedLogin("one", "ACCESS", null), tokens_wiped_at: null }];
    expect(await wipeConnectionTokens(db, "social_accounts", "id", "sa1")).toBe(true);
    expect(vault.get("one-a")).toBe(WIPED_TOKEN_MARKER);
  });

  it("when a secret cannot be wiped it says so and does NOT record the row as wiped (the sweep will retry)", async () => {
    tables.social_accounts = [{ id: "sa1", account_id: "acc1", ...seedLogin("one", "ACCESS", "REFRESH"), tokens_wiped_at: null }];
    failFor.add("one-r");
    expect(await wipeConnectionTokens(db, "social_accounts", "id", "sa1")).toBe(false);
    expect(tables.social_accounts[0].tokens_wiped_at).toBeNull();
  });

  it("works for the Google connection tables, looked up by account", async () => {
    tables.google_calendar_connections = [{ id: "g1", account_id: "acc1", ...seedLogin("gc", "G-ACCESS", "G-REFRESH"), tokens_wiped_at: null }];
    tables.google_sheets_connections = [{ id: "s1", account_id: "acc1", ...seedLogin("gs", "S-ACCESS", "S-REFRESH"), tokens_wiped_at: null }];
    expect(await wipeConnectionTokens(db, "google_calendar_connections", "account_id", "acc1")).toBe(true);
    expect(vault.get("gc-a")).toBe(WIPED_TOKEN_MARKER);
    expect(vault.get("gs-a")).toBe("S-ACCESS"); // Sheets was not asked to wipe
  });
});

describe("sweepDisconnectedTokens", () => {
  it("wipes every disconnected, not-yet-wiped connection in all three tables, and nothing else", async () => {
    const t = new Date().toISOString();
    tables.social_accounts = [
      { id: "old-disconnected", ...seedLogin("a", "A-TOKEN", "A-REFRESH"), disconnected_at: t, tokens_wiped_at: null },
      { id: "connected", ...seedLogin("b", "B-TOKEN", "B-REFRESH"), disconnected_at: null, tokens_wiped_at: null },
      { id: "already-wiped", ...seedLogin("c", "revoked", null), disconnected_at: t, tokens_wiped_at: t },
    ];
    tables.google_calendar_connections = [{ id: "g1", ...seedLogin("d", "D-TOKEN", "D-REFRESH"), disconnected_at: t, tokens_wiped_at: null }];
    tables.google_sheets_connections = [{ id: "s1", ...seedLogin("e", "E-TOKEN", null), disconnected_at: null, tokens_wiped_at: null }];

    const r = await sweepDisconnectedTokens(db);

    expect(r).toEqual({ wiped: 2, failed: 0 });
    expect(vault.get("a-a")).toBe(WIPED_TOKEN_MARKER);
    expect(vault.get("a-r")).toBe(WIPED_TOKEN_MARKER);
    expect(vault.get("d-a")).toBe(WIPED_TOKEN_MARKER);
    expect(vault.get("b-a")).toBe("B-TOKEN"); // still connected: untouched
    expect(vault.get("e-a")).toBe("E-TOKEN"); // still connected: untouched
    expect(tables.social_accounts[0].tokens_wiped_at).toBeTruthy();
  });

  it("retries a failure on the next sweep, and then succeeds", async () => {
    const t = new Date().toISOString();
    tables.social_accounts = [{ id: "sa1", ...seedLogin("a", "A", "R"), disconnected_at: t, tokens_wiped_at: null }];
    failFor.add("a-r");
    expect(await sweepDisconnectedTokens(db)).toEqual({ wiped: 0, failed: 1 });
    expect(tables.social_accounts[0].tokens_wiped_at).toBeNull();

    failFor.clear();
    expect(await sweepDisconnectedTokens(db)).toEqual({ wiped: 1, failed: 0 });
    expect(vault.get("a-r")).toBe(WIPED_TOKEN_MARKER);
    expect(tables.social_accounts[0].tokens_wiped_at).toBeTruthy();

    expect(await sweepDisconnectedTokens(db)).toEqual({ wiped: 0, failed: 0 }); // nothing left to do
  });
});
