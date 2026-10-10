// The live probe must bypass quietly when there are no usable keys (exit 0, one SKIPPED line, never the network), and
// must never print a key when there are. fetch is a mock that fails the test if it is touched where it must not be.

import { describe, it, expect, vi } from "vitest";
import { runProbe, loadKeys } from "./live-x-byok-probe.js";

const KEYS = { apiKey: "PROBEapiKEY0123456789abcd", apiSecret: "PROBEapiSECRET0123456789abcdefghijklmnop", accessToken: "999-PROBEaccessTOKEN0123456789abcdef", accessTokenSecret: "PROBEtokenSECRET0123456789abcdefghijklmnop" };
const SECRETS = Object.values(KEYS);

function harness(fileText: string | Error, fetchImpl?: typeof fetch) {
  const lines: string[] = [];
  const fetchSpy = vi.fn(fetchImpl ?? (async () => { throw new Error("the network must not be touched"); }));
  const deps = {
    readFile: async (_p: string) => {
      if (fileText instanceof Error) throw fileText;
      return fileText;
    },
    fetchImpl: fetchSpy as unknown as typeof fetch,
    log: (l: string) => void lines.push(l),
  };
  return { lines, fetchSpy, deps };
}

describe("bypasses gracefully when there are no usable keys", () => {
  const cases: Array<[string, string[], string | Error]> = [
    ["no path argument", [], "unused"],
    ["a flag but no path", ["--post"], "unused"],
    ["a file that does not exist", ["nope.json"], Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })],
    ["a file that cannot be read", ["locked.json"], Object.assign(new Error("EACCES"), { code: "EACCES" })],
    ["a file that is not JSON", ["bad.json"], "this is { not json"],
    ["a JSON file that is an array", ["arr.json"], "[1,2,3]"],
    ["a JSON file missing a field", ["k.json"], JSON.stringify({ apiKey: "a", apiSecret: "b", accessToken: "c" })],
    ["a field that is an empty string", ["k.json"], JSON.stringify({ ...KEYS, apiSecret: "" })],
    ["a field that is only spaces", ["k.json"], JSON.stringify({ ...KEYS, accessToken: "   " })],
    ["a field that is not a string", ["k.json"], JSON.stringify({ ...KEYS, accessTokenSecret: 12345 })],
  ];
  for (const [name, argv, file] of cases) {
    it(`${name}: one SKIPPED line, exit 0, fetch never called`, async () => {
      const h = harness(file);
      const code = await runProbe(argv, h.deps);
      expect(code).toBe(0);
      expect(h.fetchSpy).not.toHaveBeenCalled();
      expect(h.lines).toHaveLength(1);
      expect(h.lines[0]).toMatch(/^SKIPPED: .*No network request was made\.$/);
    });
  }

  it("the very first case reads exactly as documented", async () => {
    const h = harness("unused");
    await runProbe([], h.deps);
    expect(h.lines[0]).toBe("SKIPPED: no X keys file (pass a JSON path). No network request was made.");
  });

  it("with the real file system, a missing file is also a clean skip", async () => {
    const lines: string[] = [];
    const fetchSpy = vi.fn();
    const code = await runProbe(["definitely-not-a-real-file-x-byok.json"], { log: (l) => void lines.push(l), fetchImpl: fetchSpy as never });
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines[0]).toMatch(/^SKIPPED: .*No network request was made\.$/);
  });

  it("a skip line never contains file content", async () => {
    const h = harness(JSON.stringify({ apiKey: KEYS.apiKey }));
    await runProbe(["k.json"], h.deps);
    expect(SECRETS.some((s) => h.lines.join("\n").includes(s))).toBe(false);
  });

  it("loadKeys trims valid values and reports every missing field", async () => {
    expect(await loadKeys("k.json", { readFile: async () => JSON.stringify({ ...KEYS, apiKey: `  ${KEYS.apiKey} ` }) })).toMatchObject({ ok: true, bundle: { apiKey: KEYS.apiKey } });
    const r = await loadKeys("k.json", { readFile: async () => "{}" });
    expect(r).toEqual({ ok: false, reason: "X keys file is missing: apiKey, apiSecret, accessToken, accessTokenSecret" });
  });
});

describe("with keys loaded", () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("runs every step against a mocked X, prints PASS/FAIL, and never prints a key", async () => {
    let n = 0;
    const h = harness(JSON.stringify(KEYS), (async (url: string, init?: RequestInit) => {
      n += 1;
      const u = String(url);
      if (u.endsWith("/2/users/me")) return reply(200, { data: { id: "7", username: "probe_acct" } });
      if (u.endsWith("/initialize")) return reply(403, { title: "Forbidden", type: "https://api.x.com/2/problems/oauth1-permissions", detail: "not allowed" });
      if (u.includes("command=INIT")) return reply(200, { media_id_string: "55" });
      if (u.includes("upload.twitter.com")) return new Response(null, { status: 204 });
      if (u.endsWith("/2/tweets") && init?.method === "POST") return reply(201, { data: { id: "900" } });
      if (u.endsWith("/2/tweets/900") && init?.method === "DELETE") return reply(200, { data: { deleted: true } });
      return reply(404, {});
    }) as typeof fetch);
    const code = await runProbe(["keys.json", "--post"], h.deps);
    const out = h.lines.join("\n");
    expect(code).toBe(0);
    expect(n).toBeGreaterThan(5);
    expect(out).toMatch(/1\. PASS +GET \/2\/users\/me/);
    expect(out).toMatch(/FAIL +v2 initialize +status 403 +title: Forbidden +type: https:\/\/api\.x\.com\/2\/problems\/oauth1-permissions +detail: not allowed/);
    expect(out).toMatch(/3\. PASS +media upload \(v1\.1\) accepted/);
    expect(out).toMatch(/v2 did not work, v1\.1 WORKS/);
    expect(out).toMatch(/4\. PASS +POST \/2\/tweets .*post id 900 \(with media\)/);
    expect(out).toMatch(/4\. PASS +DELETE \/2\/tweets\/900 .*deleted/);
    expect(out).toContain("****abcd");
    expect(SECRETS.some((s) => out.includes(s))).toBe(false);
    expect(out).not.toMatch(/Authorization|oauth_signature/i);
  });

  it("without --post it creates and deletes nothing", async () => {
    const methods: string[] = [];
    const h = harness(JSON.stringify(KEYS), (async (url: string, init?: RequestInit) => {
      methods.push(`${init?.method ?? "GET"} ${String(url)}`);
      return reply(402, { title: "CreditsDepleted", detail: "no credits" });
    }) as typeof fetch);
    const code = await runProbe(["keys.json"], h.deps);
    expect(code).toBe(0);
    expect(methods.some((m) => m.endsWith("/2/tweets") || m.startsWith("DELETE"))).toBe(false);
    expect(h.lines.join("\n")).toMatch(/credits, spending-limit, permission or rate-limit answer from X/);
    expect(h.lines.join("\n")).toMatch(/4\. SKIPPED/);
  });

  it("an unexpected bug after the keys were loaded exits non-zero, with a message that carries no key", async () => {
    const h = harness(JSON.stringify(KEYS));
    h.deps.log = (l: string) => {
      if (l.startsWith("X BYOK live probe")) throw new Error(`boom ${KEYS.apiSecret}`);
      h.lines.push(l);
    };
    const code = await runProbe(["keys.json"], h.deps);
    expect(code).toBe(1);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatch(/^FAILED: unexpected error/);
    expect(SECRETS.some((s) => h.lines[0].includes(s))).toBe(false);
  });
});
