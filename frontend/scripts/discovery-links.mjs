// Footer "discovery" links: every page links to all comparison and
// schedule-to-platform pages so Google can reach them from any crawled page.
// The URL list is read from public/sitemap.xml so it cannot drift.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://lazyrelay.com";
// Pages the backend generates (backend/src/mcp/mcpDocs.ts, mcpApiPage.ts). Its tests require
// the committed file to equal the generator output byte for byte, so they are left alone here.
export const BACKEND_GENERATED = new Set(["mcp/tools/index.html", "docs/mcp-api/index.html"]);
const MARKER = 'class="footer-discovery"';

const ALT_NAMES = {
  postdodo: "PostDodo", buffer: "Buffer", hootsuite: "Hootsuite", metricool: "Metricool",
  later: "Later", "sprout-social": "Sprout Social", socialbee: "SocialBee", publer: "Publer",
  postiz: "Postiz", publora: "Publora", ayrshare: "Ayrshare", planable: "Planable",
  agorapulse: "Agorapulse", loomly: "Loomly",
};
const PLATFORM_NAMES = {
  facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", pinterest: "Pinterest",
  youtube: "YouTube", linkedin: "LinkedIn", threads: "Threads", mastodon: "Mastodon",
  bluesky: "Bluesky", telegram: "Telegram", discord: "Discord", tumblr: "Tumblr",
  wordpress: "WordPress", devto: "DEV", hashnode: "Hashnode", lemmy: "Lemmy", slack: "Slack",
};

export function loadSitemapUrls(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(SITE, ""));
}

function groups(sitemapPaths) {
  const alts = sitemapPaths
    .map((p) => p.match(/^\/alternatives\/([a-z0-9-]+)\/$/))
    .filter(Boolean)
    .map((m) => m[1]);
  const plats = sitemapPaths
    .map((p) => p.match(/^\/schedule-to-([a-z0-9-]+)\/$/))
    .filter(Boolean)
    .map((m) => m[1]);
  for (const s of alts) if (!ALT_NAMES[s]) throw new Error(`No display name for alternative "${s}"`);
  for (const s of plats) if (!PLATFORM_NAMES[s]) throw new Error(`No display name for platform "${s}"`);
  return { alts, plats };
}

export function expectedLinkPaths(sitemapPaths) {
  const { alts, plats } = groups(sitemapPaths);
  return ["/alternatives/", ...alts.map((s) => `/alternatives/${s}/`), ...plats.map((s) => `/schedule-to-${s}/`)];
}

export function discoveryLinks(sitemapPaths) {
  const { alts, plats } = groups(sitemapPaths);
  return {
    compare: [{ href: "/alternatives/", label: "All comparisons" }, ...alts.map((s) => ({ href: `/alternatives/${s}/`, label: ALT_NAMES[s] }))],
    schedule: plats.map((s) => ({ href: `/schedule-to-${s}/`, label: PLATFORM_NAMES[s] })),
  };
}

function line(title, links) {
  return `  <p ${MARKER}>${title}: ${links.map((l) => `<a href="${l.href}">${l.label}</a>`).join(" &middot; ")}</p>\n`;
}

export function loadDiscoveryBlock() {
  const xml = fs.readFileSync(path.join(root, "public", "sitemap.xml"), "utf8");
  const { compare, schedule } = discoveryLinks(loadSitemapUrls(xml));
  return line("Compare", compare) + line("Schedule to", schedule);
}

// Inserts the block just before the copyright note, or before </footer>.
// Idempotent: a footer that already has the block is returned unchanged.
export function injectDiscovery(html, block = loadDiscoveryBlock()) {
  const first = html.indexOf("<footer");
  if (first === -1 || html.indexOf("</footer>") === -1) return html;
  // Drop any earlier copy of the block so a changed sitemap refreshes it.
  const old = new RegExp(`[ \\t]*<p ${MARKER}>.*?</p>[ \\t]*\\r?\\n`, "g");
  html = html.slice(0, first) + html.slice(first).replace(old, "");
  const start = html.indexOf("<footer");
  const end = html.indexOf("</footer>");
  const footer = html.slice(start, end);
  // Insert at the start of the line holding the copyright note, so the block
  // always lands on its own lines whatever the file's line endings are.
  const note = footer.search(/<p class="note">/);
  const lineStart = footer.lastIndexOf("\n", note) + 1;
  const ownLine = note !== -1 && footer.slice(lineStart, note).trim() === "";
  const at = note === -1 ? end : start + (ownLine ? lineStart : note);
  const eol = html.includes("\r\n") ? "\r\n" : "\n";
  return html.slice(0, at) + block.replace(/\n/g, eol) + html.slice(at);
}
