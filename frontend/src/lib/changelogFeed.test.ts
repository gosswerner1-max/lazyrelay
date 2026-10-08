import { describe, expect, it } from "vitest";
// The frontend has no Node typings (tsc -b checks test files too), so the two files this reads come in with Vite's ?raw import.
import page from "../../public/changelog/index.html?raw";
import feed from "../../public/changelog.xml?raw";

// /changelog.xml is generated from /changelog/ by scripts/generate-changelog-feed.mjs. This fails if someone adds an
// entry to the page without regenerating the feed (Directree and other directories read the feed, not the page).
describe("changelog feed", () => {
  const pageDates = [...page.matchAll(/<span class="entry-date" id="d-(\d{4}-\d{2}-\d{2})">/g)].map((m) => m[1]);
  const feedDates = [...feed.matchAll(/<id>https:\/\/lazyrelay\.com\/changelog\/#d-(\d{4}-\d{2}-\d{2})<\/id>/g)].map((m) => m[1]);

  it("every dated heading on the page has an id the feed can link to", () => {
    const headings = [...page.matchAll(/<span class="entry-date"/g)].length;
    expect(pageDates.length).toBe(headings);
    expect(pageDates.length).toBeGreaterThan(5);
  });

  it("has one feed entry per page entry, in the same order", () => {
    expect(feedDates).toEqual(pageDates);
  });

  it("is a well-formed Atom feed whose newest entry matches the page", () => {
    expect(feed.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(feed).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(feed.trimEnd().endsWith("</feed>")).toBe(true);
    expect(feed).toContain(`<updated>${pageDates[0]}T00:00:00Z</updated>`);
    expect((feed.match(/<entry>/g) ?? []).length).toBe((feed.match(/<\/entry>/g) ?? []).length);
  });

  it("the page advertises the feed", () => {
    expect(page).toContain('href="/changelog.xml"');
  });

  it("makes no claim the product does not back up", () => {
    // Draft-first AI replies are switched off for everyone; the changelog must not announce them.
    expect(page.toLowerCase()).not.toContain("suggested repl");
    expect(page.toLowerCase()).not.toContain("draft-first");
  });
});
