// Adds the footer discovery links to every static page and a git-based
// <lastmod> to every sitemap URL. Safe to run repeatedly.
// Run: node scripts/add-discovery-links.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BACKEND_GENERATED, injectDiscovery, loadDiscoveryBlock } from "./discovery-links.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const SITE = "https://lazyrelay.com";

// 1. Footer block on every static page that has a footer.
const block = loadDiscoveryBlock();
let changed = 0;
let skipped = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name === "index.html") {
      if (BACKEND_GENERATED.has(path.relative(publicDir, full).replaceAll("\\", "/"))) { skipped++; continue; }
      const html = fs.readFileSync(full, "utf8");
      if (/<meta[^>]+name="robots"[^>]+noindex/i.test(html)) { skipped++; continue; }
      const next = injectDiscovery(html, block);
      if (next !== html) { fs.writeFileSync(full, next); changed++; }
    }
  }
}
walk(publicDir);
console.log(`footers updated: ${changed}, noindex pages skipped: ${skipped}`);

// 2. lastmod = date of the last git commit that touched the page's source file.
function sourceFor(urlPath) {
  if (urlPath === "/") return path.join(root, "src", "pages", "LandingV2.tsx");
  // Legal pages are React-rendered, so their source is the component file.
  const reactPages = { "/terms/": "TermsOfService.tsx", "/privacy/": "PrivacyPolicy.tsx", "/dpa/": "DPA.tsx" };
  if (reactPages[urlPath]) return path.join(root, "src", "pages", reactPages[urlPath]);
  return path.join(publicDir, urlPath.replace(/^\/|\/$/g, ""), "index.html");
}
function gitDate(file) {
  if (!fs.existsSync(file)) return null;
  const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", file], { cwd: root, encoding: "utf8" }).trim();
  return out || null;
}
const sitemapFile = path.join(publicDir, "sitemap.xml");
let xml = fs.readFileSync(sitemapFile, "utf8");
const eol = xml.includes("\r\n") ? "\r\n" : "\n";
const missing = [];
xml = xml.replace(/<url>[\s\S]*?<\/url>/g, (blockXml) => {
  const loc = blockXml.match(/<loc>([^<]+)<\/loc>/)[1];
  const date = gitDate(sourceFor(loc.replace(SITE, "")));
  if (!date) { missing.push(loc); return blockXml; }
  const clean = blockXml.replace(/\s*<lastmod>[^<]*<\/lastmod>/, "");
  return clean.replace(/(<loc>[^<]+<\/loc>)/, `$1${eol}    <lastmod>${date}</lastmod>`);
});
fs.writeFileSync(sitemapFile, xml);
console.log(`sitemap lastmod set; urls with no git-tracked source: ${missing.length}`);
missing.forEach((m) => console.log("  - no source/commit for", m));
