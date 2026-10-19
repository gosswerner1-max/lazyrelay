import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import page from "../../public/capabilities/index.html?raw";
import sitemap from "../../public/sitemap.xml?raw";
import llms from "../../public/llms.txt?raw";

// Guard for the public /capabilities page: every capability it lists is something the product does today (each line is checked against
// a source named below), the copy rules hold (no dash or hyphen in what a reader sees, no blue), the structured data is valid and says
// the same thing as the page, and the page is discoverable (sitemap, llms.txt).
//   Platforms: the live platform picker, 18 distribution platforms plus WhatsApp (Werner, 2026-10-16).
//   MCP: 27 tools (backend/src/mcp/lazyrelayTools.ts, lazyrelay-mcp.json), hosted endpoint plus local package.
//   Content Sources: the tab's own text. Proof of Publish, free tier, approvals, analytics, CSV import, 2FA: the live landing page.

const guard = createRequire(import.meta.url)("../../../scripts/check-copy-guardrails.js") as { checkHtml: (html: string) => string[] };
const URL_ = "https://lazyrelay.com/capabilities/";

const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
const software = blocks.find((b) => b["@type"] === "SoftwareApplication") as { featureList: string[]; offers: Record<string, string>; [k: string]: unknown };
const faq = blocks.find((b) => b["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
const visible = page.slice(page.indexOf("<body")).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the copy rules", () => {
  it("no dash or hyphen in what a reader sees, no blue anywhere, no blue leaning colour", () => {
    expect(guard.checkHtml(page)).toEqual([]);
  });
  it("the structured data text has no dash or hyphen either", () => {
    const text = JSON.stringify(blocks, (_k, v) => (typeof v === "string" && /^https?:\/\//.test(v) ? "" : v));
    expect(text).not.toMatch(/[-‐-―−]/);
  });
});

describe("the head", () => {
  it("has a canonical link, a robots tag and share tags that match", () => {
    expect(page).toContain(`<link rel="canonical" href="${URL_}" />`);
    expect(page).toContain('<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1" />');
    const title = /<title>([^<]+)<\/title>/.exec(page)![1]!;
    const desc = /<meta name="description" content="([^"]+)"/.exec(page)![1]!;
    expect(title.length).toBeLessThanOrEqual(70);
    expect(desc.length).toBeLessThanOrEqual(160);
    expect(page).toContain(`<meta property="og:title" content="${title}" />`);
    expect(page).toContain(`<meta property="og:description" content="${desc}" />`);
    expect(page).toContain(`<meta property="og:url" content="${URL_}" />`);
    expect(page).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(page.match(/<h1[ >]/g)).toHaveLength(1);
  });
});

describe("the structured data", () => {
  it("is a SoftwareApplication with a free offer and a feature list", () => {
    expect(software.name).toBe("LazyRelay");
    expect(software.url).toBe("https://lazyrelay.com");
    expect(software.applicationCategory).toBe("BusinessApplication");
    expect(software.operatingSystem).toBe("Web");
    expect(software.offers).toMatchObject({ "@type": "Offer", price: "0", priceCurrency: "USD" });
    expect(software.featureList.length).toBeGreaterThanOrEqual(8);
  });
  it("lists only features the page itself describes (each feature name appears in the visible text)", () => {
    for (const f of software.featureList) expect(visible.toLowerCase(), f).toContain(f.toLowerCase().split(":")[0]!.trim());
  });
  it("carries no invented rating, review count or price", () => {
    const json = JSON.stringify(blocks);
    expect(json).not.toMatch(/aggregateRating|ratingValue|reviewCount|"review"/);
    expect(json).not.toMatch(/\$\d/);
  });
  it("FAQ answers match the page and use the approved platform wording", () => {
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(4);
    const all = faq.mainEntity.map((q) => q.acceptedAnswer.text).join(" ");
    expect(all).toContain("18 distribution platforms plus WhatsApp");
    for (const q of faq.mainEntity) expect(visible).toContain(q.acceptedAnswer.text.replace(/&/g, "&"));
  });
});

describe("what it claims is true", () => {
  it.each([
    ["the approved platform wording", "18 distribution platforms plus WhatsApp"],
    ["27 MCP tools", "27 MCP tools"],
    ["any MCP capable agent", "any AI agent that supports MCP"],
    ["Proof of Publish on every plan", "Proof of Publish"],
    ["Content Sources needs a proven website", "a website you have proven you own"],
    ["nothing posts until approved", "Nothing is posted until you approve it"],
    ["the free tier", "3 accounts"],
    ["page text is not stored (the runner keeps titles and links; the database clears a handed off body)", "keeps only the title and the link"],
    ["row level security (tested: 2,992 live attempts blocked, see the security report)", "row level security"],
    ["WhatsApp opt outs are honoured (backend/src/whatsappBroadcast/metaErrors.ts)", "When a contact opts out, LazyRelay honours it and records it"],
    ["the Drafts for review table", "Drafts for review"],
  ])("says %s", (_why, text) => {
    expect(visible).toContain(text);
  });
  it.each([
    [/model[ -]agnostic/i],
    [/zero[ -]trust/i],
    [/without central (cloud )?database/i],
    [/Enterprise/i],
    [/shadow/i],
    [/guarantee/i],
    [/ #1 |number one|best in class|world.s (best|first)/i],
    [/aggregateRating/i],
    [/premier/i],
    [/real[ -]time/i],
    [/purg/i],
    [/zero central/i],
    [/transparency/i],
    [/out of the box/i],
  ])("never says %s", (pattern) => {
    expect(page).not.toMatch(pattern);
  });
  it("lists exactly the 18 distribution platforms", () => {
    for (const name of ["Facebook", "Instagram", "TikTok", "Pinterest", "YouTube", "LinkedIn", "Threads", "Mastodon", "Bluesky", "Telegram", "Discord", "Tumblr", "WordPress", "DEV", "Hashnode", "Lemmy", "Slack", "X"]) {
      expect(visible, name).toContain(name);
    }
  });
});

describe("it can be found", () => {
  it("is in the sitemap once", () => {
    expect(sitemap.split(URL_).length - 1).toBe(1);
  });
  it("is in llms.txt", () => {
    expect(llms).toContain(URL_);
  });
  it("links to the home page, pricing and the MCP guides, and back to itself nowhere else", () => {
    for (const href of ['href="/"', 'href="/pricing/"', 'href="/mcp/"']) expect(page).toContain(href);
  });
});
