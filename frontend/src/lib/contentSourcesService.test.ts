import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentSourcesError, createNotConnectedClient, createServiceClient, createSessionTokenProvider } from "./contentSources";

// The thin service plumbing the competitor box and the status panel share: the session token, the readiness check, and the
// "Not connected yet" client. Everything here runs against a fake fetch: nothing touches a network.

const TOKEN = "tok_SECRET_session_value_123";
const DASH = /[\u2013\u2014]/;

afterEach(() => vi.restoreAllMocks());

async function errorOf(p: Promise<unknown>): Promise<ContentSourcesError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ContentSourcesError);
  return e as ContentSourcesError;
}

describe("createServiceClient", () => {
  it("refuses an address that is not a plain https address", () => {
    for (const bad of ["http://service.example", "not a url", "https://user:pw@service.example", "https://service.example/?a=1", "https://service.example/#x"]) {
      expect(() => createServiceClient({ baseUrl: bad }), bad).toThrow();
    }
  });

  it("has only the readiness check: no source, key or proof call is left on it", () => {
    const client = createServiceClient({ baseUrl: "https://service.example" });
    expect(Object.keys(client)).toEqual(["ready"]);
  });
});

describe("the not connected client", () => {
  it("has no readiness check, so the status panel says Unknown, and it never touches the network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createNotConnectedClient();
    expect(client.ready).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ContentSourcesError", () => {
  it("gives every code a plain sentence with no em or en dash and no token", () => {
    for (const code of ["not_connected", "sign_in", "try_later", "network", "bad_response", "internal"] as const) {
      const e = new ContentSourcesError(code);
      expect(e.code).toBe(code);
      expect(e.message.length).toBeGreaterThan(10);
      expect(e.message).not.toMatch(DASH);
    }
  });

  it("says Not connected yet for not_connected", () => {
    expect(new ContentSourcesError("not_connected").message).toMatch(/^Not connected yet/);
  });
});

describe("session token provider", () => {
  const session = (over: Record<string, unknown> = {}) => ({ token: TOKEN, expiresAt: new Date(NOW + 10 * 60_000).toISOString(), ...over });
  const NOW = Date.parse("2026-10-19T10:00:00.000Z");

  function provider(fetchSession: () => Promise<unknown>, clock = { t: NOW }) {
    return { clock, p: createSessionTokenProvider({ fetchSession: fetchSession as () => Promise<{ token: string; expiresAt: string }>, now: () => clock.t }) };
  }

  it("returns the token and reuses it until 30 seconds before it expires", async () => {
    const fetchSession = vi.fn(async () => session());
    const { p, clock } = provider(fetchSession);
    expect(await p.getToken()).toBe(TOKEN);
    expect(await p.getToken()).toBe(TOKEN);
    expect(fetchSession).toHaveBeenCalledTimes(1);
    clock.t = NOW + 10 * 60_000 - 31_000; // 31 seconds left: still good
    await p.getToken();
    expect(fetchSession).toHaveBeenCalledTimes(1);
    clock.t = NOW + 10 * 60_000 - 30_000; // exactly 30 seconds left: ask again
    await p.getToken();
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

  it("shares one request between calls made at the same time", async () => {
    let finish!: (v: unknown) => void;
    const fetchSession = vi.fn(() => new Promise((res) => (finish = res)));
    const { p } = provider(fetchSession);
    const all = Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    finish(session());
    expect(await all).toEqual([TOKEN, TOKEN, TOKEN]);
    expect(fetchSession).toHaveBeenCalledTimes(1);
  });

  it("a token that is already inside the 30 seconds is used once and not kept", async () => {
    const fetchSession = vi.fn(async () => session({ expiresAt: new Date(NOW + 10_000).toISOString() }));
    const { p } = provider(fetchSession);
    expect(await p.getToken()).toBe(TOKEN);
    await p.getToken();
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

  it("invalidate makes the next call ask again", async () => {
    const fetchSession = vi.fn(async () => session());
    const { p } = provider(fetchSession);
    await p.getToken();
    p.invalidate();
    await p.getToken();
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

  it("a failed request is not kept, and the next call tries again", async () => {
    const fetchSession = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Request failed: 503"), { status: 503 }))
      .mockResolvedValueOnce(session());
    const { p } = provider(fetchSession);
    expect((await errorOf(p.getToken())).code).toBe("try_later");
    expect(await p.getToken()).toBe(TOKEN);
  });

  it("404 means the feature is switched off for now: Not connected yet", async () => {
    const { p } = provider(async () => Promise.reject(Object.assign(new Error("Request failed: 404"), { status: 404 })));
    const e = await errorOf(p.getToken());
    expect(e.code).toBe("not_connected");
    expect(e.message).toMatch(/^Not connected yet/);
  });

  it("401 and a missing sign in mean sign in again; 503 means try later; anything else is a plain failure", async () => {
    const cases: Array<[Error, string]> = [
      [Object.assign(new Error("Request failed: 401"), { status: 401 }), "sign_in"],
      [new Error("Not signed in"), "sign_in"],
      [Object.assign(new Error("Request failed: 503"), { status: 503 }), "try_later"],
      [Object.assign(new Error("Request failed: 500"), { status: 500 }), "internal"],
      [new TypeError("Failed to fetch"), "network"],
    ];
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [err, code] of cases) {
      const { p } = provider(async () => Promise.reject(err));
      expect((await errorOf(p.getToken())).code, err.message).toBe(code);
    }
  });

  it("rejects a session answer of the wrong shape, without echoing it", async () => {
    for (const bad of [null, {}, { token: "" , expiresAt: "2026-10-19T10:10:00Z" }, { token: TOKEN }, { token: TOKEN, expiresAt: "not a date" }, { token: 5, expiresAt: "2026-10-19T10:10:00Z" }]) {
      const { p } = provider(async () => bad);
      const e = await errorOf(p.getToken());
      expect(e.code).toBe("bad_response");
      expect(e.message).not.toContain(TOKEN);
    }
  });

  it("never stores the token and never logs it", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { p } = provider(async () => session());
    await p.getToken();
    await p.getToken();
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(TOKEN);
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(TOKEN);
    for (const l of logs) expect(JSON.stringify(l.mock.calls)).not.toContain(TOKEN);
  });
});
