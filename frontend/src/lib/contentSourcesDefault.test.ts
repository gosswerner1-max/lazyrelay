import { afterEach, describe, expect, it, vi } from "vitest";

// The client the status panel uses. It is built from the build setting VITE_CONTENT_SOURCES_API_URL: unset (or not https) means
// no readiness check and no network call at all; set means a readiness check against that address. It needs no LazyRelay
// session: the competitor box has its own client for the signed in calls.

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ authedFetch }));

import { buildContentSourcesClient } from "./contentSourcesDefault";

afterEach(() => {
  vi.restoreAllMocks();
  authedFetch.mockReset();
});

describe("buildContentSourcesClient", () => {
  it("without an address: no readiness check, no session request and no network call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const unset of [undefined, "", "   "]) {
      expect(buildContentSourcesClient(unset).ready).toBeUndefined();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it("an address that is not https is refused loudly and treated as not connected", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = buildContentSourcesClient("http://service.example");
    expect(client.ready).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it("with an https address: asks GET /v1/ready on that address, with no LazyRelay session and no token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    const client = buildContentSourcesClient("https://service.example/");
    expect(await client.ready!()).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://service.example/v1/ready");
    expect(JSON.stringify((init as RequestInit).headers ?? {})).not.toMatch(/authorization/i);
    expect((init as RequestInit).credentials).toBe("omit");
    expect(authedFetch).not.toHaveBeenCalled();
  });
});
