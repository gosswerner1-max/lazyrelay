import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

// The copy guardrails for the newest comparison pages (scripts/check-copy-guardrails.js). These tests prove the check CAN fail,
// so a green run means something, and that it does not trip on things that are allowed (the platform name Bluesky, hyphens
// inside attributes and CSS, which are not visible text).

const guard = createRequire(import.meta.url)("../../../scripts/check-copy-guardrails.js") as {
  SLUGS: string[];
  checkHtml: (html: string) => string[];
  run: (slugs?: string[], root?: string) => number;
};

const page = (body: string, extraHead = "") => `<!doctype html><html><head><title>T</title>${extraHead}</head><body><main>${body}</main></body></html>`;

describe("what it rejects", () => {
  it("a hyphen between words in visible text", () => {
    expect(guard.checkHtml(page("<p>AI-agent access</p>"))).toEqual([expect.stringContaining("dash or hyphen")]);
  });
  it("an em dash and an en dash typed as characters", () => {
    expect(guard.checkHtml(page("<p>one \u2014 two</p>")).length).toBeGreaterThan(0);
    expect(guard.checkHtml(page("<p>1\u20132</p>")).length).toBeGreaterThan(0);
  });
  it("a dash written as an entity", () => {
    expect(guard.checkHtml(page("<p>one &mdash; two</p>")).length).toBeGreaterThan(0);
    expect(guard.checkHtml(page("<p>one &#8212; two</p>")).length).toBeGreaterThan(0);
    expect(guard.checkHtml(page("<p>one &ndash; two</p>")).length).toBeGreaterThan(0);
  });
  it("a hyphen inside a heading, a table cell or a list item", () => {
    for (const html of ["<h2>Pick it</h2><h3>Re-check</h3>", "<table><tr><td>first-comment</td></tr></table>", "<ul><li>sign-off</li></ul>"]) {
      expect(guard.checkHtml(page(html)).length, html).toBeGreaterThan(0);
    }
  });
  it("the word blue anywhere, including a class name", () => {
    expect(guard.checkHtml(page("<p>a blue button</p>")).length).toBeGreaterThan(0);
    expect(guard.checkHtml(page('<p class="blue">x</p>')).length).toBeGreaterThan(0);
  });
  it("a blue leaning colour in the styles", () => {
    expect(guard.checkHtml(page("<p>x</p>", "<style>a { color: #1a73e8; }</style>")).length).toBeGreaterThan(0);
    expect(guard.checkHtml(page("<p>x</p>", "<style>a { color: #00f; }</style>")).length).toBeGreaterThan(0);
  });
});

describe("what it allows", () => {
  it("the platform name Bluesky", () => {
    expect(guard.checkHtml(page("<p>Posts to Bluesky and Mastodon</p>"))).toEqual([]);
  });
  it("hyphens that are not visible text: attributes, URLs, meta names, scripts and CSS property names", () => {
    const html = page(
      '<p><a href="https://example.com/some-page" class="back-link" data-x="a-b">Read more</a></p><script type="application/ld+json">{"a-b":"c-d"}</script>',
      '<meta name="twitter:card" content="summary-large" /><style>.a { background-color: #fff; border-left: 3px solid #ff5630; }</style>',
    );
    expect(guard.checkHtml(html)).toEqual([]);
  });
  it("the page's own warm accent colours", () => {
    expect(guard.checkHtml(page("<p>x</p>", "<style>a { color: #c82400; background: #ff5630; }</style>"))).toEqual([]);
  });
});

describe("it cannot pass by checking nothing", () => {
  it("a page it is told to check that does not exist fails", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(guard.run(["no-such-page"], "C:/does/not/exist")).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  it("the real pages pass", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(guard.run()).toBe(0);
    log.mockRestore();
    expect(guard.SLUGS).toEqual(["coschedule", "socialpilot", "sendible", "zohosocial", "meetedgar", "planoly"]);
  });
});
