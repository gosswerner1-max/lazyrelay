// The relay address guard: every forbidden form, with DNS stubbed so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns", () => ({ promises: { lookup: (...args: unknown[]) => lookup(...args) } }));

const { parseRelayUrl, guardRelay, guardRelays, cleanRelayList, MAX_RELAYS } = await import("./nostrRelayGuard.js");

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("parseRelayUrl (syntax)", () => {
  it("accepts a plain public wss address and canonicalises it", () => {
    expect(parseRelayUrl("wss://relay.damus.io")).toEqual({ ok: true, url: "wss://relay.damus.io", host: "relay.damus.io" });
    expect(parseRelayUrl("WSS://Relay.Damus.IO/")).toMatchObject({ ok: true, url: "wss://relay.damus.io" });
    expect(parseRelayUrl("wss://nos.lol:443")).toMatchObject({ ok: true, url: "wss://nos.lol" });
    expect(parseRelayUrl("  wss://nos.lol  ")).toMatchObject({ ok: true });
  });

  const forbidden: Array<[string, string]> = [
    ["plain ws", "ws://relay.damus.io"],
    ["https", "https://relay.damus.io"],
    ["no scheme", "relay.damus.io"],
    ["file scheme", "file:///etc/passwd"],
    ["ipv4 literal", "wss://93.184.216.34"],
    ["loopback ipv4", "wss://127.0.0.1"],
    ["loopback short form", "wss://127.1"],
    ["hex ipv4", "wss://0x7f.0.0.1"],
    ["decimal ipv4", "wss://2130706433"],
    ["octal ipv4", "wss://0177.0.0.1"],
    ["metadata address", "wss://169.254.169.254"],
    ["private 10/8", "wss://10.0.0.5"],
    ["private 192.168", "wss://192.168.1.1"],
    ["ipv6 loopback", "wss://[::1]"],
    ["ipv6 mapped", "wss://[::ffff:127.0.0.1]"],
    ["ipv6 public literal", "wss://[2606:4700:4700::1111]"],
    ["localhost", "wss://localhost"],
    ["localhost subdomain", "wss://relay.localhost"],
    ["single label", "wss://intranet"],
    [".local", "wss://printer.local"],
    [".internal", "wss://relay.internal"],
    [".lan", "wss://nas.lan"],
    [".onion", "wss://abcdefghijklmnop.onion"],
    ["numeric tld", "wss://relay.123"],
    ["trailing dot", "wss://relay.damus.io."],
    ["userinfo", "wss://user:pass@relay.damus.io"],
    ["userinfo only user", "wss://user@relay.damus.io"],
    ["custom port", "wss://relay.damus.io:8080"],
    ["low port", "wss://relay.damus.io:22"],
    ["a path", "wss://relay.damus.io/nostr"],
    ["a query", "wss://relay.damus.io/?x=1"],
    ["a fragment", "wss://relay.damus.io/#x"],
    ["backslash trick", "wss://relay.damus.io\\@evil.com"],
    ["space", "wss://relay.damus.io evil.com"],
    ["newline", "wss://relay.damus.io\nwss://evil.com"],
    ["empty", ""],
    ["too long", `wss://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.com`],
  ];
  for (const [name, input] of forbidden) {
    it(`refuses ${name}`, () => {
      expect(parseRelayUrl(input).ok, input).toBe(false);
    });
  }

  it("refuses things that are not text", () => {
    for (const v of [null, undefined, 5, {}, ["wss://relay.damus.io"]]) expect(parseRelayUrl(v).ok).toBe(false);
  });
});

describe("guardRelay (resolve, then check)", () => {
  it("returns the addresses to pin the socket to", async () => {
    const r = await guardRelay("wss://relay.damus.io");
    expect(r).toEqual({ ok: true, relay: { url: "wss://relay.damus.io", host: "relay.damus.io", addresses: ["93.184.216.34"] } });
  });

  it("refuses a public looking name that resolves to a private, loopback or metadata address", async () => {
    for (const address of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "192.168.0.9", "::1", "fd00::1", "::ffff:127.0.0.1", "fe80::1"]) {
      lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
      expect((await guardRelay("wss://sneaky.example.org")).ok, address).toBe(false);
    }
  });

  it("refuses when ANY of several answers is private (a mixed answer is the rebinding trick)", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    expect((await guardRelay("wss://mixed.example.org")).ok).toBe(false);
  });

  it("fails closed when the name does not resolve", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    expect((await guardRelay("wss://gone.example.org")).ok).toBe(false);
  });

  it("does not even resolve a name that fails the syntax check", async () => {
    await guardRelay("ws://relay.damus.io");
    await guardRelay("wss://127.0.0.1");
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("lists", () => {
  it("cleanRelayList drops bad entries, de-duplicates and caps the count", () => {
    const many = Array.from({ length: 12 }, (_, i) => `wss://relay${i}.example.org`);
    expect(cleanRelayList(many)).toHaveLength(MAX_RELAYS);
    expect(cleanRelayList(["wss://a.example.org", "WSS://A.EXAMPLE.ORG/", "ws://b.example.org", "wss://127.0.0.1", 7, null])).toEqual(["wss://a.example.org"]);
    expect(cleanRelayList("wss://a.example.org")).toEqual([]);
  });

  it("guardRelays keeps only the relays that pass the network check", async () => {
    lookup.mockImplementation(async (host: string) => (host === "bad.example.org" ? [{ address: "10.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]));
    const ok = await guardRelays(["wss://good.example.org", "wss://bad.example.org", "wss://also-good.example.org"]);
    expect(ok.map((r) => r.host)).toEqual(["good.example.org", "also-good.example.org"]);
  });
});
