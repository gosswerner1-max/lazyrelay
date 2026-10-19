import { afterEach, describe, expect, it, vi } from "vitest";

// The client the dashboard uses. It is built from the build setting VITE_CONTENT_SOURCES_API_URL: unset (or not https) means
// "Not connected yet" and no network call at all; set means the real service client with a LazyRelay session token.

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ authedFetch }));

import { buildContentSourcesClient } from "./contentSourcesDefault";

afterEach(() => {
  vi.restoreAllMocks();
  authedFetch.mockReset();
});

const TOKEN = "session-token-abc";
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();

describe("buildContentSourcesClient", () => {
  it("without an address: Not connected yet, no session request and no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const unset of [undefined, "", "   "]) {
      const client = buildContentSourcesClient(unset);
      await expect(client.getCredentials()).rejects.toMatchObject({ code: "not_connected" });
      await expect(client.listSources()).rejects.toMatchObject({ code: "not_connected" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it("an address that is not https is refused loudly and treated as not connected", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = buildContentSourcesClient("http://service.example");
    await expect(client.listSources()).rejects.toMatchObject({ code: "not_connected" });
    expect(errorSpy).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it("with an https address: asks LazyRelay for a session once, then calls the service with that token", async () => {
    authedFetch.mockResolvedValue({ token: TOKEN, expiresAt: future() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ sources: [] }), { status: 200 }));
    const client = buildContentSourcesClient("https://service.example/");
    await client.listSources();
    await client.listSources();
    expect(authedFetch).toHaveBeenCalledTimes(1);
    expect(authedFetch).toHaveBeenCalledWith("/content-sources/session", { method: "POST" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://service.example/v1/sources");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect((init as RequestInit).credentials).toBe("omit");
  });

  it("a 404 from the session call means switched off for now, and the service is never called", async () => {
    authedFetch.mockRejectedValue(Object.assign(new Error("Request failed: 404"), { status: 404 }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = buildContentSourcesClient("https://service.example");
    await expect(client.getCredentials()).rejects.toMatchObject({ code: "not_connected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("when the service answers 401 the kept token is dropped, so the next call asks for a new one", async () => {
    authedFetch.mockResolvedValue({ token: TOKEN, expiresAt: future() });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 }));
    const client = buildContentSourcesClient("https://service.example");
    await expect(client.listSources()).rejects.toMatchObject({ code: "unauthorized" });
    await expect(client.listSources()).rejects.toMatchObject({ code: "unauthorized" });
    expect(authedFetch).toHaveBeenCalledTimes(2);
  });
});
