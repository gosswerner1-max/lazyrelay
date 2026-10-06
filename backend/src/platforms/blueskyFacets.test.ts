import { describe, it, expect } from "vitest";
import { buildBlueskyFacets } from "./blueskyFacets.js";

const slice = (text: string, f: { index: { byteStart: number; byteEnd: number } }) => Buffer.from(text, "utf8").subarray(f.index.byteStart, f.index.byteEnd).toString("utf8");

describe("Bluesky facets", () => {
  it("makes a plain URL a link, pointing at exactly the URL", () => {
    const text = "Details: https://lazyrelay.com/changelog";
    const f = buildBlueskyFacets(text);
    expect(f).toHaveLength(1);
    expect(slice(text, f[0])).toBe("https://lazyrelay.com/changelog");
    expect(f[0].features[0]).toEqual({ $type: "app.bsky.richtext.facet#link", uri: "https://lazyrelay.com/changelog" });
  });

  it("uses BYTE offsets: an emoji or an accent before the link must not shift it", () => {
    const text = "Café 🚀 launch: https://lazyrelay.com/x";
    const f = buildBlueskyFacets(text);
    expect(slice(text, f[0])).toBe("https://lazyrelay.com/x");
  });

  it("leaves the full stop, comma or closing bracket after a URL out of the link", () => {
    for (const [text, url] of [
      ["See https://lazyrelay.com/a.", "https://lazyrelay.com/a"],
      ["See https://lazyrelay.com/a, then b", "https://lazyrelay.com/a"],
      ["(see https://lazyrelay.com/a)", "https://lazyrelay.com/a"],
      ["Wiki https://en.wikipedia.org/wiki/Foo_(bar) ok", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ] as const) {
      const f = buildBlueskyFacets(text);
      expect(slice(text, f[0]), text).toBe(url);
    }
  });

  it("makes hashtags tag facets, but not a bare number or a # inside a URL", () => {
    const text = "Launch day #socialmedia #2026 https://example.com/page#section and #a-b";
    const f = buildBlueskyFacets(text);
    const tags = f.filter((x) => x.features[0].$type === "app.bsky.richtext.facet#tag").map((x) => slice(text, x));
    expect(tags).toEqual(["#socialmedia", "#a-b"]);
    expect(f.filter((x) => x.features[0].$type === "app.bsky.richtext.facet#link")).toHaveLength(1);
  });

  it("returns nothing for text with no links or tags, and ignores a non-URL", () => {
    expect(buildBlueskyFacets("Just words. Nothing to link, version 1.2.3")).toEqual([]);
    expect(buildBlueskyFacets("see http://localhost and https://nodot")).toEqual([]);
  });

  it("links a bare domain to its https address, with or without a path", () => {
    for (const [text, shown] of [
      ["Try it at lazyrelay.com", "lazyrelay.com"],
      ["Try lazyrelay.com.", "lazyrelay.com"],
      ["(lazyrelay.com)", "lazyrelay.com"],
      ["See lazyrelay.com/pricing, then decide", "lazyrelay.com/pricing"],
      ["Café 🚀 www.lazyrelay.com/x", "www.lazyrelay.com/x"],
      ["Site: example.co.za!", "example.co.za"],
      ["LAZYRELAY.COM wins", "LAZYRELAY.COM"],
    ] as const) {
      const f = buildBlueskyFacets(text);
      expect(f, text).toHaveLength(1);
      expect(slice(text, f[0]), text).toBe(shown);
      expect(f[0].features[0], text).toEqual({ $type: "app.bsky.richtext.facet#link", uri: `https://${shown}` });
    }
  });

  it("does not turn file names, code, versions, emails or handles into links", () => {
    for (const text of [
      "Run node.js and install.sh then open index.html",
      "Version 1.2.3 of app.py and v2.0 ship e.g. today",
      "Mail hello@lazyrelay.com or jo.me@x.org",
      "Follow @lazyrelay.bsky.social now",
      "A path /docs/lazyrelay.com is not a domain",
      "lazyrelay.community and notes.txt and a.b",
    ]) {
      expect(buildBlueskyFacets(text), text).toEqual([]);
    }
  });

  it("does not double-link a full URL, and still tags next to a bare domain", () => {
    const text = "Go https://lazyrelay.com/a and lazyrelay.com #launch";
    const f = buildBlueskyFacets(text);
    expect(f.map((x) => slice(text, x))).toEqual(["https://lazyrelay.com/a", "lazyrelay.com", "#launch"]);
  });

  it("keeps facets in text order", () => {
    const text = "#first https://a.example/x #second";
    const f = buildBlueskyFacets(text);
    expect(f.map((x) => slice(text, x))).toEqual(["#first", "https://a.example/x", "#second"]);
  });
});
