import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../../lib/supabase", () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } } }));
const { readAndClearConnectParams, CONNECT_ERROR_FALLBACK } = await import("./dashboardHelpers");

const FRIENDLY = "We could not finish connecting that account. Please try again, and contact support if it keeps happening.";

function openWith(search: string) {
  window.history.replaceState({}, "", `/${search}`);
}
afterEach(() => window.history.replaceState({}, "", "/"));

describe("the connectError the callback redirects with", () => {
  it("uses the same friendly sentence the server sends", () => {
    expect(CONNECT_ERROR_FALLBACK).toBe(FRIENDLY);
  });

  it("shows the server's message as it is when there is a normal one", () => {
    openWith(`?connectError=${encodeURIComponent(FRIENDLY)}`);
    expect(readAndClearConnectParams().connectError).toBe(FRIENDLY);
    expect(window.location.search).toBe(""); // read once and cleared, as before
  });

  it("shows no banner when the message is empty or blank, and still clears the param", () => {
    openWith("?connectError=");
    expect(readAndClearConnectParams().connectError).toBeNull();
    expect(window.location.search).toBe("");
    openWith("?connectError=%20%20");
    expect(readAndClearConnectParams().connectError).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("falls back to the friendly sentence when the message is a long blob, not a sentence", () => {
    openWith(`?connectError=${encodeURIComponent("x".repeat(500))}`);
    expect(readAndClearConnectParams().connectError).toBe(FRIENDLY);
  });

  it("stays null when there is no connectError at all", () => {
    openWith("?connected=1");
    expect(readAndClearConnectParams().connectError).toBeNull();
  });
});
