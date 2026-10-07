// Disconnecting Google Calendar or Google Sheets destroys the stored Google login. For Calendar the login is still needed
// to stop the push notifications, so the wipe must come AFTER that step.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables, vault } from "./testFakeSupabase.js";

vi.mock("./supabase.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return { supabase: { from: (t: string) => f.makeBuilder(t), rpc: (fn: string, args: Record<string, unknown>) => f.fakeRpc(fn, args) } };
});
const loginSeenWhenWatchStopped = vi.hoisted(() => ({ value: "" as string | undefined }));
vi.mock("./googleCalendar/pushNotifications.js", async () => {
  const f = await import("./testFakeSupabase.js");
  return {
    startWatchingConnection: vi.fn(async () => {}),
    stopWatchingConnection: vi.fn(async () => {
      loginSeenWhenWatchStopped.value = f.vault.get("cal-a");
    }),
  };
});

vi.mock("./googleSheets/oauthClient.js", () => ({
  getAuthorizeUrl: vi.fn(() => "https://accounts.example/auth"),
  exchangeCode: vi.fn(async () => ({ accessToken: "NEW-G-ACCESS", refreshToken: "NEW-G-REFRESH", expiresAt: "2026-11-01T00:00:00.000Z" })),
  fetchConnectedEmail: vi.fn(async () => "owner@example.com"),
}));
vi.mock("./googleCalendar/oauthClient.js", () => ({
  getAuthorizeUrl: vi.fn(() => "https://accounts.example/auth"),
  exchangeCode: vi.fn(async () => ({ accessToken: "NEW-G-ACCESS", refreshToken: "NEW-G-REFRESH", expiresAt: "2026-11-01T00:00:00.000Z" })),
  fetchConnectedEmail: vi.fn(async () => "owner@example.com"),
}));

const { disconnectGoogleCalendar, completeGoogleCalendarConnect } = await import("./googleCalendar/connect.js");
const { disconnectGoogleSheets, completeGoogleSheetsConnect } = await import("./googleSheets/connect.js");

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  loginSeenWhenWatchStopped.value = "";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("disconnecting Google Calendar", () => {
  it("stops the watch first (it needs the login), then overwrites the login", async () => {
    vault.set("cal-a", "CAL-ACCESS");
    vault.set("cal-r", "CAL-REFRESH");
    tables.google_calendar_connections = [
      { id: "g1", account_id: "acc1", access_token_vault_id: "cal-a", refresh_token_vault_id: "cal-r", watch_channel_id: "ch", watch_resource_id: "res", disconnected_at: null, tokens_wiped_at: null },
    ];
    await disconnectGoogleCalendar("acc1");
    expect(loginSeenWhenWatchStopped.value).toBe("CAL-ACCESS"); // still readable when the watch was stopped
    expect(vault.get("cal-a")).toBe("revoked");
    expect(vault.get("cal-r")).toBe("revoked");
    expect(tables.google_calendar_connections[0].disconnected_at).toBeTruthy();
    expect(tables.google_calendar_connections[0].tokens_wiped_at).toBeTruthy();
  });

  it("does not touch another account's connection", async () => {
    vault.set("cal-a", "MINE");
    vault.set("other-a", "SOMEONE-ELSES");
    tables.google_calendar_connections = [
      { id: "g1", account_id: "acc1", access_token_vault_id: "cal-a", refresh_token_vault_id: null, disconnected_at: null, tokens_wiped_at: null },
      { id: "g2", account_id: "acc2", access_token_vault_id: "other-a", refresh_token_vault_id: null, disconnected_at: null, tokens_wiped_at: null },
    ];
    await disconnectGoogleCalendar("acc1");
    expect(vault.get("other-a")).toBe("SOMEONE-ELSES");
    expect(tables.google_calendar_connections[1].disconnected_at).toBeNull();
  });
});

describe("disconnecting Google Sheets", () => {
  it("overwrites the stored login", async () => {
    vault.set("sh-a", "SHEETS-ACCESS");
    vault.set("sh-r", "SHEETS-REFRESH");
    tables.google_sheets_connections = [
      { id: "s1", account_id: "acc1", access_token_vault_id: "sh-a", refresh_token_vault_id: "sh-r", disconnected_at: null, tokens_wiped_at: null },
    ];
    await disconnectGoogleSheets("acc1");
    expect(vault.get("sh-a")).toBe("revoked");
    expect(vault.get("sh-r")).toBe("revoked");
    expect(tables.google_sheets_connections[0].tokens_wiped_at).toBeTruthy();
  });
});

describe("reconnecting Google Calendar or Sheets replaces the stored login and wipes the old one", () => {
  const future = () => new Date(Date.now() + 600_000).toISOString();
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "cal1", spreadsheetId: "sp1", sheets: [{ properties: { sheetId: 0 } }] }), { status: 200 })));
  });

  it("Calendar", async () => {
    vault.set("old-a", "OLD-G-ACCESS");
    vault.set("old-r", "OLD-G-REFRESH");
    tables.google_calendar_oauth_states = [{ id: "st1", account_id: "acc1", expires_at: future() }];
    tables.google_calendar_connections = [
      { id: "g1", account_id: "acc1", access_token_vault_id: "old-a", refresh_token_vault_id: "old-r", disconnected_at: "2026-10-01T00:00:00.000Z", tokens_wiped_at: "2026-10-01T00:00:01.000Z" },
    ];
    await completeGoogleCalendarConnect("st1", "code");
    const row = tables.google_calendar_connections[0];
    expect(row.tokens_wiped_at).toBeNull();
    expect(row.disconnected_at).toBeNull();
    expect(vault.get(row.access_token_vault_id as string)).toBe("NEW-G-ACCESS");
    expect(vault.get("old-a")).toBe("revoked");
    expect(vault.get("old-r")).toBe("revoked");
  });

  it("Sheets", async () => {
    vault.set("old-a", "OLD-S-ACCESS");
    vault.set("old-r", "OLD-S-REFRESH");
    tables.google_sheets_oauth_states = [{ id: "st1", account_id: "acc1", expires_at: future() }];
    tables.google_sheets_connections = [
      { id: "s1", account_id: "acc1", access_token_vault_id: "old-a", refresh_token_vault_id: "old-r", disconnected_at: "2026-10-01T00:00:00.000Z", tokens_wiped_at: "2026-10-01T00:00:01.000Z" },
    ];
    await completeGoogleSheetsConnect("st1", "code");
    const row = tables.google_sheets_connections[0];
    expect(row.tokens_wiped_at).toBeNull();
    expect(vault.get(row.access_token_vault_id as string)).toBe("NEW-G-ACCESS");
    expect(vault.get("old-a")).toBe("revoked");
    expect(vault.get("old-r")).toBe("revoked");
  });
});
