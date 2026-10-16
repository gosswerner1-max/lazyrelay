import { describe, expect, it } from "vitest";
import about from "../../public/about/index.html?raw";
import buffer from "../../public/alternatives/buffer/index.html?raw";
import hootsuite from "../../public/alternatives/hootsuite/index.html?raw";
import socialbee from "../../public/alternatives/socialbee/index.html?raw";
import { HOME_FAQ } from "./homeFaq";

// Fact guard for the comparison pages and the AI-replies sentence (2026-10-15). Each expectation names the source it
// was checked against, so a future edit that drifts from the source fails here instead of going live.
//   Buffer facts: buffer.com/pricing, read 2026-10-15. SocialBee facts: socialbee.com/pricing, read 2026-10-15.
//   AI replies: REPLY_DRAFTS_ENABLED=true on Render since 2026-10-12 (paid plans, Mastodon and Bluesky, nothing posts
//   until the customer approves).

const unesc = (s: string) => s.replace(/&amp;/g, "&").replace(/&mdash;/g, " ").replace(/&times;/g, "x");
const pages = { buffer, hootsuite, socialbee };

describe("AI-suggested replies are live, so no page may say they are not available", () => {
  it("About page text and FAQ schema", () => {
    expect(about).not.toMatch(/AI-suggested replies are not yet available/);
    expect(about).toContain("it can draft a suggested reply for Mastodon and Bluesky comments");
  });
  it("home FAQ", () => {
    expect(HOME_FAQ.map((f) => f.a).join("\n")).not.toMatch(/AI-suggested replies are not available yet/);
  });
});

describe("Buffer page matches buffer.com/pricing", () => {
  it("lists 12 channels including Substack", () => {
    expect(buffer).toContain("12: Facebook, Instagram, TikTok, Pinterest, YouTube, LinkedIn, Threads, Mastodon, Bluesky, X, Google Business Profile, Substack");
    expect(buffer).not.toContain("<td>11: Facebook");
  });
  it("does not state a 20 channel dollar total (Buffer lowers the price per channel above 10 channels)", () => {
    expect(unesc(buffer)).not.toMatch(/20 channels on Buffer Essentials is \$100/);
    expect(unesc(buffer)).not.toMatch(/20 x \$5 = \$100/);
    expect(buffer).toContain("price per channel falls after 10 channels");
  });
  it("browser extension is on every Buffer plan, not Essentials and up", () => {
    expect(buffer).not.toContain("First-comment scheduling, hashtag suggestions, browser extension");
    expect(buffer).toMatch(/Browser extension<\/td><td>[^<]*<\/td><td>Included on every plan/);
  });
  it("says LazyRelay offers X (own developer keys) and not Google Business Profile", () => {
    expect(buffer).not.toMatch(/isn't planning to|no plans to add either/);
    expect(buffer).toContain("does not offer Google Business Profile today");
    expect(buffer).not.toContain("does not offer X");
  });
});

describe("SocialBee page matches socialbee.com/pricing", () => {
  it("does not claim SocialBee lacks Bluesky, Telegram or Mastodon", () => {
    expect(socialbee).not.toContain("Telegram, Discord, Mastodon, Bluesky, Tumblr");
    expect(socialbee).not.toContain("You post to Telegram, Discord, Mastodon, Bluesky, or Tumblr");
    expect(socialbee).toContain("Bluesky: supported");
    expect(socialbee).toContain("Universal Posting");
    expect(socialbee).toContain("You post to Discord or Tumblr.");
  });
});

describe("share and robots tags on the three comparison pages", () => {
  for (const [name, html] of Object.entries(pages)) {
    it(`${name} has og:*, twitter and robots tags that match its canonical`, () => {
      const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
      expect(canonical).toBe(`https://lazyrelay.com/alternatives/${name}/`);
      expect(html).toContain('<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1" />');
      const title = /<title>([^<]+)<\/title>/.exec(html)![1];
      const desc = /<meta name="description" content="([^"]+)"/.exec(html)![1];
      expect(html).toContain(`<meta property="og:title" content="${title}" />`);
      expect(html).toContain(`<meta property="og:description" content="${desc}" />`);
      expect(html).toContain(`<meta property="og:url" content="${canonical}" />`);
      expect(html).toContain('<meta property="og:type" content="website" />');
      expect(html).toContain('<meta property="og:image" content="https://lazyrelay.com/og-image-1200x630.jpg" />');
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(html).toContain(`<meta name="twitter:title" content="${title}" />`);
    });
  }
});

describe("the same fixes in the FAQPage structured data", () => {
  it("Buffer FAQ schema no longer states the 20 channel total", () => {
    const ld = [...buffer.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
    expect(ld).not.toMatch(/20 channels on Buffer Essentials is \$100/);
  });
});
