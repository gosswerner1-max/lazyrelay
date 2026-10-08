// Builds the Atom feed at /changelog.xml from the dated entries on /changelog/ (public/changelog/index.html).
// The page is the single source of truth: add an entry there, run this script, commit both files.
// A test (src/lib/changelogFeed.test.ts) fails if the feed is out of date, so the two can never drift apart.
//   node scripts/generate-changelog-feed.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public", "changelog", "index.html"), "utf8").replace(/\r\n/g, "\n");
const SITE = "https://lazyrelay.com";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const text = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&middot;/g, "·")
    .replace(/\s+/g, " ")
    .trim();

const entries = [];
const re = /<span class="entry-date" id="d-(\d{4}-\d{2}-\d{2})">([^<]+)<\/span>\s*<ul>([\s\S]*?)<\/ul>/g;
let m;
while ((m = re.exec(html))) {
  const [, iso, label, body] = m;
  const items = [...body.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => text(x[1]));
  entries.push({ iso, label: text(label), items });
}
if (entries.length === 0) throw new Error("no dated entries found on the changelog page");

const short = (s, n) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(" ", n - 1)).replace(/[,;:.\s]+$/, "") + "...");
const updated = (iso) => `${iso}T00:00:00Z`;
const feed = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<feed xmlns="http://www.w3.org/2005/Atom">',
  "  <title>LazyRelay changelog</title>",
  "  <subtitle>What is actually shipped, in plain language, most recent first.</subtitle>",
  `  <link rel="self" type="application/atom+xml" href="${SITE}/changelog.xml"/>`,
  `  <link rel="alternate" type="text/html" href="${SITE}/changelog/"/>`,
  `  <id>${SITE}/changelog/</id>`,
  `  <updated>${updated(entries[0].iso)}</updated>`,
  "  <author><name>LazyRelay</name></author>",
  ...entries.flatMap((e) => [
    "  <entry>",
    `    <title>${esc("LazyRelay update, " + e.label)}</title>`,
    `    <link rel="alternate" type="text/html" href="${SITE}/changelog/#d-${e.iso}"/>`,
    `    <id>${SITE}/changelog/#d-${e.iso}</id>`,
    `    <updated>${updated(e.iso)}</updated>`,
    `    <summary type="text">${esc(e.items.map((i) => short(i, 160)).join(" | "))}</summary>`,
    "  </entry>",
  ]),
  "</feed>",
  "",
].join("\n");

writeFileSync(join(root, "public", "changelog.xml"), feed, "utf8");
console.log(`changelog.xml written: ${entries.length} entries, newest ${entries[0].iso}`);
