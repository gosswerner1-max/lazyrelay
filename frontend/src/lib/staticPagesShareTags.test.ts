import { describe, expect, it } from "vitest";

// Share-tag guard for every hand-written static page under public/ (2026-10-15). The Nick Launches site audit found
// that none of the pages outside the five fixed in PR #132 carried og:* or twitter:* tags, so a shared link to any of
// them rendered as a bare URL. Each page's tags must mirror its own title, description and canonical link, so a
// future edit to one without the other fails here.
const pages = import.meta.glob("../../public/**/index.html", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

const IMAGE = "https://lazyrelay.com/og-image-1200x630.jpg";
const ROBOTS = "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1";

// The about page is generated and the 404 page is noindex; neither belongs in this guard.
const entries = Object.entries(pages).filter(([path]) => !path.includes("/public/index.html"));

const tag = (html: string, attr: "name" | "property", key: string) =>
  html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1];

describe("static pages carry share and robots tags that mirror the page itself", () => {
  it("finds the static pages", () => {
    expect(entries.length).toBeGreaterThan(60);
  });

  it.each(entries)("%s", (_path, html) => {
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
    const description = tag(html, "name", "description");
    const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
    expect(title, "title").toBeTruthy();
    expect(description, "description").toBeTruthy();
    expect(canonical, "canonical").toBeTruthy();

    expect(tag(html, "property", "og:title")).toBe(title);
    expect(tag(html, "property", "og:description")).toBe(description);
    expect(tag(html, "property", "og:url")).toBe(canonical);
    expect(tag(html, "property", "og:type")).toBe("website");
    expect(tag(html, "property", "og:site_name")).toBe("LazyRelay");
    expect(tag(html, "property", "og:image")).toBe(IMAGE);
    expect(tag(html, "property", "og:image:width")).toBe("1200");
    expect(tag(html, "property", "og:image:height")).toBe("630");
    expect(tag(html, "property", "og:image:alt")).toBeTruthy();
    expect(tag(html, "name", "twitter:card")).toBe("summary_large_image");
    expect(tag(html, "name", "twitter:title")).toBe(title);
    expect(tag(html, "name", "twitter:description")).toBe(description);
    expect(tag(html, "name", "twitter:image")).toBe(IMAGE);
    expect(tag(html, "name", "robots")).toBe(ROBOTS);
  });
});
