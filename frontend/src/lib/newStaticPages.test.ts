/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Guard for the four public pages restyled in the Midnight Canvas look (canvas #0b0f19, panels #141b2d, locked orange #ff5630):
// /capabilities/, /guides/, /docs/ and /mcp/. They are static HTML, so there is no build flag: these tests are the safety net.
// Content stays the content of the previous public file (links, JSON-LD, meta, discovery footers); only the look changed.
//   Platform wording (Werner, 2026-10-16): the count is only ever "18 distribution platforms plus WhatsApp".
//   Pricing is quoted without tax words. No purple or violet anywhere. No dash used as punctuation in the copy.
//   CSP (frontend/public/.htaccess): fonts and scripts only from the site itself, so no Google Fonts and no inline scripts.

const PUBLIC = join(__dirname, "..", "..", "public");
const read = (rel: string) => readFileSync(join(PUBLIC, rel), "utf8");

const PAGES = {
  capabilities: { file: "capabilities/index.html", canonical: "https://lazyrelay.com/capabilities/" },
  guides: { file: "guides/index.html", canonical: "https://lazyrelay.com/guides/" },
  docs: { file: "docs/index.html", canonical: "https://lazyrelay.com/docs/" },
  mcp: { file: "mcp/index.html", canonical: "https://lazyrelay.com/mcp/" },
} as const;
type Name = keyof typeof PAGES;
const names = Object.keys(PAGES) as Name[];

const html = Object.fromEntries(names.map((n) => [n, read(PAGES[n].file)])) as Record<Name, string>;
const css = read("assets-static/lr-site.css");
const js = read("assets-static/lr-site.js");

const visible = (page: string) =>
  page
    .slice(page.indexOf("<body"))
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rarr;/g, "->")
    .replace(/\s+/g, " ");

// Hue of a hex colour in degrees (0 when grey). Hues 250 to 330 are the purple and violet band, which is banned.
function hue(hex: string): number | null {
  const h = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.1) return null;
  let H = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  H *= 60;
  return H < 0 ? H + 360 : H;
}
const purpleHexes = (text: string) =>
  [...text.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)].map((m) => m[0]).filter((x) => {
    const H = hue(x.slice(1));
    return H !== null && H >= 250 && H <= 330;
  });

describe("the shared stylesheet and script exist and obey the site policy", () => {
  it("are plain files under public/assets-static", () => {
    expect(css.length).toBeGreaterThan(5000);
    expect(js.length).toBeGreaterThan(2000);
  });
  it("load nothing from another host: no web font link, no import, no remote url()", () => {
    expect(css).not.toMatch(/@import|url\(\s*["']?https?:|fonts\.googleapis|fonts\.gstatic/);
    expect(js).not.toMatch(/fonts\.googleapis|fonts\.gstatic|https?:\/\/(?!www\.w3\.org)/);
  });
  it("carries the locked palette and no other brand colour", () => {
    for (const token of ["#0b0f19", "#141b2d", "#ff5630", "#ff7a58"]) expect(css.toLowerCase()).toContain(token);
  });
  it("has no purple or violet hue in the stylesheet, the script or the icons", () => {
    expect(purpleHexes(css)).toEqual([]);
    expect(purpleHexes(js)).toEqual([]);
    const dir = join(PUBLIC, "assets-static", "icons");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".svg"))) {
      expect(purpleHexes(readFileSync(join(dir, f), "utf8")), f).toEqual([]);
    }
  });
  it("draws the Mastodon, Discord, Slack and Nostr logos in slate with a grayscale filter", () => {
    for (const name of ["mastodon", "discord", "slack", "nostr"]) {
      const rule = new RegExp(`[^{}]*${name}[^{}]*\\{[^}]*grayscale\\(`, "i");
      expect(css, name).toMatch(rule);
    }
  });
  it("keeps the motion fallbacks: reduced motion, reduced transparency and more contrast", () => {
    for (const q of ["prefers-reduced-motion", "prefers-reduced-transparency", "prefers-contrast"]) expect(css).toContain(q);
  });
  it("never leaves the page invisible when scripts do not run", () => {
    expect(css).toMatch(/@media\s*\(scripting:\s*none\)/);
  });
  it("the script only reads, never fetches or posts", () => {
    expect(js).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|eval\(|new Function|document\.write/);
  });
});

describe.each(names)("%s page", (name) => {
  const page = html[name];
  const text = visible(page);

  it("keeps its canonical link, the full robots tag and the share tags", () => {
    expect(page).toContain(`<link rel="canonical" href="${PAGES[name].canonical}" />`);
    expect(page).toContain('<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1" />');
    expect(page).toContain(`<meta property="og:url" content="${PAGES[name].canonical}" />`);
    expect(page).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(page.match(/<h1[ >]/g)).toHaveLength(1);
  });

  it("loads the shared stylesheet and script from the site itself, no Google Fonts, no inline style block, no inline script", () => {
    expect(page).toContain('href="/assets-static/lr-site.css"');
    expect(page).toContain('src="/assets-static/lr-site.js"');
    expect(page).toContain('src="/consent.js"');
    expect(page).not.toMatch(/fonts\.googleapis|fonts\.gstatic|circuit-bg/);
    expect(page).not.toMatch(/<style[\s>]/);
    const inline = [...page.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
    for (const attrs of inline) expect(attrs, "only JSON-LD may be inline").toContain("application/ld+json");
  });

  it("only references local assets that exist", () => {
    for (const m of page.matchAll(/(?:src|href)="(\/assets-static\/[^"#?]+)"/g)) expect(existsSync(join(PUBLIC, m[1]!)), m[1]).toBe(true);
  });

  it("has valid JSON-LD", () => {
    const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const b of blocks) expect(() => JSON.parse(b[1]!)).not.toThrow();
  });

  it("states the platform count only as 18 distribution platforms plus WhatsApp", () => {
    expect(text).not.toMatch(/\b(17|19|20|21)\s+(social\s+|supported\s+|distribution\s+)?(platforms|networks)\b/i);
    expect(text).not.toMatch(/\b18\s+(social\s+|supported\s+)?platforms\b/i);
    const allowedElsewhere = /not one of the 18 distribution platforms|The 18 are|\(a\) 18 distribution platforms/;
    for (const m of text.matchAll(/18 (?:supported )?distribution platforms(?! plus WhatsApp)/g)) {
      const around = text.slice(Math.max(0, m.index! - 40), m.index! + m[0].length + 30);
      expect(around, `loose count near "${around}"`).toMatch(allowedElsewhere);
    }
  });

  it("never adds a tax word to a price and has no banned audience words", () => {
    expect(page).not.toMatch(/plus tax|\+ tax|before tax/i);
    expect(page).not.toMatch(/small business|\bsolo\b|solopreneur/i);
  });

  it("has no purple or violet word or hue", () => {
    expect(page).not.toMatch(/purple|violet|lavender|indigo|magenta/i);
    expect(purpleHexes(page)).toEqual([]);
  });

  it("uses no em dash, en dash or spaced hyphen as punctuation in what a reader sees", () => {
    expect(text).not.toMatch(/[‒-―−]/);
    expect(page.replace(/<script[\s\S]*?<\/script>/g, " ")).not.toMatch(/&(mdash|ndash|minus|horbar);|&#(8211|8212|8722);/i);
    expect(text).not.toMatch(/ - /);
  });

  it("has a skip link, a labelled primary nav and the shared footer links", () => {
    expect(page).toContain('class="skip"');
    expect(page).toContain('aria-label="Primary"');
    for (const href of ["/terms/", "/privacy/", "/pricing/", "/mcp/", "/guides/", "/docs/"]) expect(page, href).toContain(`href="${href}"`);
  });
});

describe("no link that was on the old public pages was dropped", () => {
  const has = (n: Name, href: string) => expect(html[n], `${n} -> ${href}`).toContain(`href="${href}"`);
  const GUIDE_LINKS = [
    "/verify-post-published/", "/social-media-scheduler-comparison/", "/ai-agent-scheduled-post-failure/", "/mastodon-bluesky-tumblr-scheduler/",
    "/free-tools/", "/developers/", "/stuck-on-what-to-post/", "/multi-brand-social-media-scheduler/", "/proof-post-went-live/",
    "/social-media-analytics-insight/", "/guides/x-developer-keys/", "/connect-zapier/", "/platform-features/", "/time-savings-calculator/",
    "/changelog/", "/in-the-works/", "/status/",
  ];
  const MCP_GUIDES = ["claude", "cursor", "windsurf", "chatgpt", "codex-cli", "n8n", "make", "gemini-cli", "vscode", "antigravity", "perplexity", "notion", "manus", "openclaw", "raycast"];
  const COMPARE = ["postdodo", "buffer", "hootsuite", "metricool", "later", "sprout-social", "socialbee", "publer", "postiz", "publora", "ayrshare", "planable", "agorapulse", "loomly"];
  const SCHEDULE_TO = ["facebook", "instagram", "tiktok", "pinterest", "youtube", "linkedin", "threads", "mastodon", "bluesky", "telegram", "discord", "tumblr", "wordpress", "devto", "hashnode", "lemmy", "slack"];

  it("guides: every guide, every MCP guide and the discovery footer", () => {
    for (const h of GUIDE_LINKS) has("guides", h);
    for (const g of MCP_GUIDES) has("guides", `/mcp/${g}/`);
    for (const c of COMPARE) has("guides", `/alternatives/${c}/`);
    for (const s of SCHEDULE_TO) has("guides", `/schedule-to-${s}/`);
    has("guides", "/alternatives/");
    has("guides", "/refunds/");
  });
  it("mcp: every client guide, the tool reference, the developers page and the discovery footer", () => {
    for (const g of MCP_GUIDES) has("mcp", `/mcp/${g}/`);
    for (const h of ["/connect-zapier/", "/mcp/tools/", "/developers/", "/docs/", "/pricing/", "/alternatives/", "/refunds/"]) has("mcp", h);
    for (const c of COMPARE) has("mcp", `/alternatives/${c}/`);
    for (const s of SCHEDULE_TO) has("mcp", `/schedule-to-${s}/`);
  });
  it("docs: the tool reference, the limits page, Zapier, About and the discovery footer", () => {
    for (const h of ["/mcp/tools/", "/docs/mcp-api/", "/connect-zapier/", "/about/", "/guides/", "/pricing/", "/alternatives/", "/refunds/"]) has("docs", h);
    for (const c of COMPARE) has("docs", `/alternatives/${c}/`);
    for (const s of SCHEDULE_TO) has("docs", `/schedule-to-${s}/`);
  });
  it("capabilities: pricing, integrations, comparisons and refunds", () => {
    for (const h of ["/pricing/", "/mcp/", "/alternatives/", "/refunds/", "/terms/", "/privacy/"]) has("capabilities", h);
  });
});

describe("the content facts of the old pages are still there", () => {
  it("docs keeps the API reference, both MCP configs and the hosted URL", () => {
    const t = visible(html.docs);
    for (const s of ["lzr_live_your_key_here", "https://lazyrelaylazyrelay-backend.onrender.com/api", "https://lazyrelaylazyrelay-backend.onrender.com/mcp", "@lazyrelay/mcp-server", "/scheduled-posts/:id", "/analytics/summary?days=30", "/mentions/reply", "Settings -> Connectors -> Add connector", "API and MCP access is included on every plan, including Free"]) {
      expect(t, s).toContain(s);
    }
    for (const tool of ["list_connected_accounts", "list_workspaces", "schedule_post", "publish_post_now", "update_post", "list_scheduled_posts", "delete_scheduled_post", "get_analytics_summary", "get_mentions"]) expect(t, tool).toContain(tool);
  });
  it("mcp keeps all 27 tools with their descriptions, the FAQ and the account note", () => {
    const t = visible(html.mcp);
    const tools = [
      "list_connected_accounts", "list_workspaces", "get_platform_rules", "get_tiktok_creator_info", "list_pinterest_boards", "get_next_free_slot", "list_posting_slots", "list_snippets",
      "schedule_post", "publish_post_now", "create_draft", "schedule_draft", "update_post", "reschedule_post", "pause_post", "resume_post", "delete_scheduled_post",
      "list_scheduled_posts", "get_proof_link", "approve_post", "create_review_link", "list_review_links", "revoke_review_link", "get_post_feedback", "reply_to_post_feedback",
      "get_analytics_summary", "get_mentions",
    ];
    expect(tools).toHaveLength(27);
    for (const tool of tools) expect(t, tool).toContain(tool);
    expect(t).toContain("Look up what a platform accepts before posting: text limit, media rules, required fields, features and options");
    expect(t).toContain("Create a link a client opens, with no account, to approve posts and comment");
    expect(t).toContain("My tool isn't on this list");
    expect(t).toContain("https://lazyrelaylazyrelay-backend.onrender.com/mcp");
    expect(t).toContain("AI agents and editors");
    expect(t).toContain("It cannot change your account settings, billing, or connected-account credentials");
  });
  it("guides keeps the three groups and the Integrations introduction", () => {
    const t = visible(html.guides);
    for (const s of ["Connect an AI agent (MCP)", "Tools and reference", "Does Your Scheduled Post Actually Publish?", "System Status"]) expect(t, s).toContain(s);
    expect(t).toContain("See the full Integrations page for all 15 at a glance");
  });
});
