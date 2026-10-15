import { describe, it, expect } from "vitest";
// The frontend has no Node typings (tsc -b checks test files too), so the file this reads comes in with Vite's ?raw import.
import indexHtml from "../../index.html?raw";

// Regression guard (2026-10-10). A search-optimisation edit on 2026-10-06 replaced <meta property="og:image:height"> with
// a literal "\1" (a regex back-reference that never expanded). Text inside <head> ends the head in the HTML parsing rules,
// so every tag after it, the canonical link, the Twitter cards and og:image:alt, was parsed into <body> on the live site,
// where search engines ignore the canonical. Nothing failed: the page still loaded. This parses the shell the way a browser
// does and checks every one of those tags lands in <head>.

const doc = new DOMParser().parseFromString(indexHtml, "text/html");

describe("index.html head", () => {
  it("has no stray text or back-reference leftovers", () => {
    expect(indexHtml).not.toMatch(/^[ \t]*\\\d+[ \t]*$/m);
    const strayText = [...doc.head.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
    expect(strayText.map((n) => n.textContent)).toEqual([]);
  });

  it("keeps the canonical link and every social tag in <head>, none of them pushed into <body>", () => {
    const inHead = (sel: string) => doc.head.querySelector(sel) !== null;
    expect(inHead('link[rel="canonical"]')).toBe(true);
    expect(inHead("title")).toBe(true);
    for (const sel of [
      'meta[property="og:title"]',
      'meta[property="og:image"]',
      'meta[property="og:image:width"]',
      'meta[property="og:image:height"]',
      'meta[property="og:image:alt"]',
      'meta[name="twitter:card"]',
      'meta[name="twitter:title"]',
      'meta[name="twitter:description"]',
      'meta[name="twitter:image"]',
    ]) {
      expect(inHead(sel), sel).toBe(true);
    }
    expect(doc.body.querySelector('link[rel="canonical"], meta[property^="og:"], meta[name^="twitter:"]')).toBeNull();
  });

  it("states the share image size that its file name says (1200 by 630)", () => {
    expect(doc.head.querySelector('meta[property="og:image"]')?.getAttribute("content")).toMatch(/1200x630/);
    expect(doc.head.querySelector('meta[property="og:image:width"]')?.getAttribute("content")).toBe("1200");
    expect(doc.head.querySelector('meta[property="og:image:height"]')?.getAttribute("content")).toBe("630");
  });
});
