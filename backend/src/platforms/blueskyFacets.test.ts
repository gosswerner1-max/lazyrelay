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

  it("keeps facets in text order", () => {
    const text = "#first https://a.example/x #second";
    const f = buildBlueskyFacets(text);
    expect(f.map((x) => slice(text, x))).toEqual(["#first", "https://a.example/x", "#second"]);
  });
});
