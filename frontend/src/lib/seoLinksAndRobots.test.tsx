import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import * as head from "./useCanonical";
import sitemapXml from "../../public/sitemap.xml?raw";

// SEO guard (2026-10-14). lazyrelay.com canonicals and the sitemap use the trailing-slash form (/pricing/), but internal
// links used the bare form (/pricing), which 301s to the slash form -- Google saw two URLs for one page. And the SPA
// fallback serves the homepage HTML (canonical "/") for client-only routes (/login, /dashboard, ...), which must be noindex.

const sitemapPaths = new Set(
  [...sitemapXml.matchAll(/<loc>https:\/\/lazyrelay\.com([^<]*)<\/loc>/g)]
    .map((m) => m[1].replace(/\/$/, ""))
    .filter((p) => p !== ""),
);

const rawSources = {
  ...import.meta.glob("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("/public/**/*.html", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("/scripts/*.mjs", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("/index.html", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

// href="..." / href: "..." / to="..." pointing at a sitemap page, with or without the site origin, no trailing slash.
const LINK = /\b(?:href|to)\s*(?:=|:)\s*\{?\s*[`"'](?:https:\/\/lazyrelay\.com)?(\/[^"'`#?\s$]*)([#?][^"'`]*)?[`"']/g;

function findBareInternalLinks(): string[] {
  const found: string[] = [];
  for (const [file, text] of Object.entries(rawSources)) {
    if (/\.test\.tsx?$/.test(file)) continue;
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(LINK)) {
        if (sitemapPaths.has(m[1])) found.push(`${file}:${i + 1}  ${m[0]}`);
      }
    });
  }
  return found;
}

describe("internal links use the sitemap's trailing-slash form", () => {
  it("reads a sane sitemap", () => {
    expect(sitemapPaths.size).toBeGreaterThan(50);
    expect(sitemapPaths.has("/pricing")).toBe(true);
  });

  it("has no bare (no-slash) href to a sitemap page in src, public HTML or generator scripts", () => {
    const bad = findBareInternalLinks();
    expect(bad.length, `${bad.length} bare links, e.g.\n${bad.slice(0, 15).join("\n")}`).toBe(0);
  });
});

const NOINDEX_ROUTES = ["/login", "/signup", "/dashboard", "/forgot-password", "/oauth/consent"];

describe("noindex routes are not in the sitemap", () => {
  it.each(NOINDEX_ROUTES)("%s is not listed", (route) => {
    expect(sitemapPaths.has(route)).toBe(false);
  });
});

const robots = () => document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');

describe("robots meta per route", () => {
  afterEach(() => {
    document.head.innerHTML = '<link rel="canonical" href="https://lazyrelay.com/" />';
  });

  it.each([
    ["/login", () => head.useCanonical("/login")],
    ["/signup", () => head.useCanonical("/signup")],
    ["/forgot-password", () => head.useCanonical("/forgot-password")],
    ["/oauth/consent", () => head.useNoindex("/oauth/consent")],
    ["/dashboard", () => head.useNoindex("/dashboard")],
    ["/dashboard/billing (sub-route)", () => head.useNoindex("/dashboard/billing")],
  ])("%s gets noindex, nofollow", (_name, useHook) => {
    document.head.innerHTML = '<link rel="canonical" href="https://lazyrelay.com/" />';
    renderHook(useHook);
    expect(robots()?.getAttribute("content")).toBe("noindex, nofollow");
  });

  it.each(["/contact", "/partners", "/docs", "/privacy"])("%s stays indexable (no robots meta)", (path) => {
    document.head.innerHTML = '<link rel="canonical" href="https://lazyrelay.com/" />';
    renderHook(() => head.useCanonical(path));
    expect(robots()).toBeNull();
  });

  it("removes the noindex again when leaving a noindex route", () => {
    document.head.innerHTML = '<link rel="canonical" href="https://lazyrelay.com/" />';
    const { unmount } = renderHook(() => head.useCanonical("/login"));
    expect(robots()).not.toBeNull();
    unmount();
    expect(robots()).toBeNull();
  });

  it("clears a stale noindex when an indexable route mounts", () => {
    document.head.innerHTML =
      '<link rel="canonical" href="https://lazyrelay.com/" /><meta name="robots" content="noindex, nofollow" />';
    renderHook(() => head.useCanonical("/contact"));
    expect(robots()).toBeNull();
  });
});

describe("noindex wiring in the page components", () => {
  const src = (name: string) => rawSources[`/src/pages/${name}.tsx`] ?? "";
  it("OAuth consent and Dashboard call useNoindex", () => {
    expect(src("OAuthConsent")).toMatch(/useNoindex\(\s*"\/oauth\/consent"\s*\)/);
    expect(src("Dashboard")).toMatch(/useNoindex\(\s*"\/dashboard"\s*\)/);
  });
});
