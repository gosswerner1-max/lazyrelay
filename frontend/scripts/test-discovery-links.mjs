// Checks that every static page links to all comparison and platform pages
// from its footer, that the React home page does too, and that every sitemap
// URL carries a lastmod date. Run: node scripts/test-discovery-links.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSitemapUrls, expectedLinkPaths } from "./discovery-links.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const failures = [];

const sitemapXml = fs.readFileSync(path.join(publicDir, "sitemap.xml"), "utf8");
const urls = loadSitemapUrls(sitemapXml);
const expected = expectedLinkPaths(urls);
if (expected.length < 30) failures.push(`expected link list too short: ${expected.length}`);

// 1. Every static page with a footer has the discovery block with every link.
let pagesChecked = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name === "index.html") checkPage(full);
  }
}
function checkPage(file) {
  const html = fs.readFileSync(file, "utf8");
  if (!html.includes("<footer")) return;
  if (/<meta[^>]+name="robots"[^>]+noindex/i.test(html)) return;
  pagesChecked++;
  const rel = path.relative(publicDir, file).replace(/\\/g, "/");
  const footer = html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
  if (!footer.includes('class="footer-discovery"')) {
    failures.push(`${rel}: no footer-discovery block`);
    return;
  }
  for (const p of expected) {
    if (!footer.includes(`href="${p}"`)) failures.push(`${rel}: footer missing ${p}`);
  }
}
walk(publicDir);

// 2. React home page footer.
const landing = fs.readFileSync(path.join(root, "src", "pages", "Landing.tsx"), "utf8");
// The link lists are constants rendered by the footer, so check the constants
// exist and the footer renders both.
const footerStart = landing.indexOf('<footer className="landing-footer">');
const landingFooter = landing.slice(footerStart);
for (const name of ["FOOTER_COMPARE_LINKS", "FOOTER_SCHEDULE_LINKS"]) {
  if (!landingFooter.includes(`${name}.map`)) failures.push(`Landing.tsx: footer does not render ${name}`);
}
for (const p of expected) {
  if (!landing.slice(0, footerStart).includes(`"${p}"`)) failures.push(`Landing.tsx: missing ${p}`);
}

// 3. Every sitemap URL has a valid lastmod.
const blocks = sitemapXml.match(/<url>[\s\S]*?<\/url>/g) || [];
for (const b of blocks) {
  const loc = (b.match(/<loc>([^<]+)/) || [])[1];
  const lm = (b.match(/<lastmod>([^<]+)/) || [])[1];
  if (!lm || !/^\d{4}-\d{2}-\d{2}$/.test(lm)) failures.push(`sitemap: ${loc} has no valid lastmod`);
}

console.log(`pages checked: ${pagesChecked}, sitemap urls: ${blocks.length}, links per footer: ${expected.length}`);
if (failures.length) {
  console.log(`FAIL: ${failures.length} problems`);
  failures.slice(0, 15).forEach((f) => console.log("  -", f));
  if (failures.length > 15) console.log(`  ... and ${failures.length - 15} more`);
  process.exit(1);
}
console.log("PASS");
