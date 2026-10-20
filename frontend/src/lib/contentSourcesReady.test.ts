import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceClient } from "./contentSources";

// The service's readiness check, used by the status panel. It needs no sign in and no token.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const getToken = vi.fn(async () => "tok_SECRET");
  const spy = vi.fn(fetchImpl);
  const client = createServiceClient({ baseUrl: "https://service.example", getToken, fetchImpl: spy as unknown as typeof fetch });
  return { client, getToken, spy };
}

describe("client.ready", () => {
  it("asks GET /v1/ready with no token and no cookies, and is true on 200", async () => {
    const { client, getToken, spy } = setup(async () => new Response("{}", { status: 200 }));
    expect(await client.ready!()).toBe(true);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://service.example/v1/ready");
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("omit");
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization/i);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("is false when the service answers with a failure", async () => {
    const { client } = setup(async () => new Response("no", { status: 503 }));
    expect(await client.ready!()).toBe(false);
  });

  it("is false when the request fails while the browser is online, and the raw error stays in the console", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = setup(async () => {
      throw new TypeError("failed to fetch");
    });
    expect(await client.ready!()).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("is null (cannot tell), not false, when the browser itself is offline", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { client } = setup(async () => {
      throw new TypeError("failed to fetch");
    });
    expect(await client.ready!()).toBeNull();
  });

  it("is false when the service does not answer within a few seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const answer = client.ready!();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await answer).toBe(false);
  });

  it("stops when the caller's signal aborts", async () => {
    const { client } = setup((_url, init) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const ctl = new AbortController();
    const answer = client.ready!(ctl.signal);
    ctl.abort();
    expect(await answer).toBe(false);
  });
});
