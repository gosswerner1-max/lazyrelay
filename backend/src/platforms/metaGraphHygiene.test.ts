// Meta call hygiene for Facebook and Instagram: connect and read Graph calls have a timeout (publish and upload calls deliberately
// have none, see metaPublishNoTimeout.test.ts), a body that is not JSON becomes a clear error,
// and the long-lived token exchange sends the app secret in a POST body instead of the URL. The ordinary Graph calls still carry
// access_token in the query string (unchanged on purpose). fetch is stubbed: nothing real is called.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FacebookAdapter } from "./facebook.js";
import { InstagramAdapter } from "./instagram.js";

const SECRET = "app-secret-value-for-tests-123";
const SHORT = "short-lived-user-token-456";
type Call = { url: string; init?: RequestInit };

function stub(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const meta = (call: Call) =>
  call.url.includes("/oauth/access_token")
    ? new URL(call.url).searchParams.has("redirect_uri") || new URLSearchParams(String(call.init?.body ?? "")).has("redirect_uri")
      ? ok({ access_token: SHORT })
      : ok({ access_token: "long-lived-user-token-789" })
    : call.url.includes("/me/accounts")
      ? ok({ data: [{ id: "p1", name: "Page", access_token: "page-token", instagram_business_account: { id: "ig1" } }] })
      : ok({ username: "acme" });

afterEach(() => vi.unstubAllGlobals());

for (const [name, make] of [
  ["facebook", () => new FacebookAdapter("cid", SECRET, "https://x.example/cb")],
  ["instagram", () => new InstagramAdapter("cid", SECRET, "https://x.example/cb")],
] as const) {
  describe(`${name} connect calls`, () => {
    it("sends the long-lived token exchange as a POST form body, with no secret or token in the URL", async () => {
      const calls = stub(meta);
      await make().listConnectOptions("thecode");
      const long = calls.find((c) => (String(c.init?.body ?? "")).includes("fb_exchange_token"));
      expect(long, "a long-lived exchange call carrying fb_exchange_token in its body").toBeDefined();
      expect(long!.url).not.toContain("client_secret");
      expect(long!.url).not.toContain("fb_exchange_token");
      expect(long!.url).not.toContain(SECRET);
      expect(long!.url).not.toContain(SHORT);
      expect(long!.init?.method).toBe("POST");
      expect(new Headers(long!.init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
      const body = new URLSearchParams(String(long!.init?.body));
      expect(body.get("grant_type")).toBe("fb_exchange_token");
      expect(body.get("client_id")).toBe("cid");
      expect(body.get("client_secret")).toBe(SECRET);
      expect(body.get("fb_exchange_token")).toBe(SHORT);
    });

    it("leaves the ordinary Graph call as it was: access_token stays in the query string", async () => {
      const calls = stub(meta);
      await make().listConnectOptions("thecode");
      const pages = calls.find((c) => c.url.includes("/me/accounts"))!;
      expect(new URL(pages.url).searchParams.get("access_token")).toBe("long-lived-user-token-789");
      expect(pages.init?.method ?? "GET").toBe("GET");
    });

    it("gives every Graph call a timeout signal", async () => {
      const calls = stub(meta);
      await make().listConnectOptions("thecode");
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const c of calls) expect(c.init?.signal, c.url).toBeInstanceOf(AbortSignal);
    });

    it("turns a body that is not JSON into a clear error", async () => {
      stub(() => new Response("<html>Bad gateway</html>", { status: 502 }));
      await expect(make().listConnectOptions("thecode")).rejects.toThrow(/could not read/i);
    });

    it("turns an empty body into a clear error", async () => {
      stub(() => new Response("", { status: 200 }));
      await expect(make().listConnectOptions("thecode")).rejects.toThrow(/could not read/i);
    });
  });
}

describe("posting: the page lookup is a read and keeps the timeout, the publish call does not", () => {
  it("facebook post()", async () => {
    const calls = stub((c) => (c.url.includes("/me") ? ok({ id: "p1" }) : ok({ id: "1_2", post_id: "1_2" })));
    await new FacebookAdapter("cid", SECRET, "u").post({ content: "hi", accessToken: "t", socialAccountId: "sa", mediaUrl: null } as never);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      if (c.init?.method === "POST") expect(c.init?.signal, c.url).toBeUndefined();
      else expect(c.init?.signal, c.url).toBeInstanceOf(AbortSignal);
    }
  });

  it("no Graph call in either adapter bypasses the timeout wrapper", () => {
    for (const file of ["facebook.ts", "instagram.ts"]) {
      const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");
      expect(source.match(/(?<![\w.])fetch\(/g), `${file} still calls fetch( directly`).toBeNull();
    }
  });
});
