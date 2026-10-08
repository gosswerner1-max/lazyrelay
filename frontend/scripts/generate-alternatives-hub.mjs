#!/usr/bin/env node
// Builds public/alternatives/index.html: a real hub page listing every LazyRelay comparison page.   (2026-10-08, SEO sweep)
// Before this the folder had no index file, so the web server showed a raw "Index of /alternatives" file listing
// (and 8 sort-order variants of it) to search engines. Reads each public/alternatives/<slug>/index.html for its title and description,
// so the hub can never disagree with the pages. Run:  node scripts/generate-alternatives-hub.mjs
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "alternatives");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const items = [];
for (const slug of readdirSync(root).sort()) {
  const f = join(root, slug, "index.html");
  if (!existsSync(f)) continue;
  const html = readFileSync(f, "utf8");
  const title = unesc(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? slug).replace(/\s*\|\s*LazyRelay\s*$/, "").trim();
  const description = unesc(/<meta name="description" content="([^"]*)"/i.exec(html)?.[1] ?? "").trim();
  items.push({ slug, title, description, url: `https://lazyrelay.com/alternatives/${slug}/` });
}
if (!items.length) throw new Error("no comparison pages found");
const ld = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "CollectionPage",
      "@id": "https://lazyrelay.com/alternatives/#page",
      url: "https://lazyrelay.com/alternatives/",
      name: "LazyRelay compared with other social media schedulers",
      description: `Side-by-side comparisons of LazyRelay with ${items.length} other social media scheduling tools: pricing, platform coverage and independent post verification.`,
      isPartOf: { "@type": "WebSite", name: "LazyRelay", url: "https://lazyrelay.com/" },
      mainEntity: { "@id": "https://lazyrelay.com/alternatives/#list" },
    },
    {
      "@type": "ItemList",
      "@id": "https://lazyrelay.com/alternatives/#list",
      numberOfItems: items.length,
      itemListElement: items.map((x, i) => ({ "@type": "ListItem", position: i + 1, url: x.url, name: x.title })),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "LazyRelay", item: "https://lazyrelay.com/" },
        { "@type": "ListItem", position: 2, name: "Compared with other schedulers", item: "https://lazyrelay.com/alternatives/" },
      ],
    },
  ],
};
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>LazyRelay Compared With Other Social Media Schedulers | LazyRelay</title>
<meta name="description" content="Side-by-side comparisons of LazyRelay with ${items.length} other social media schedulers: pricing, platform coverage and independent post verification." />
<link rel="canonical" href="https://lazyrelay.com/alternatives/" />
<link rel="icon" type="image/png" href="/favicon.png" />
<link rel="stylesheet" href="/circuit-bg.css" />
<script src="/consent.js" defer></script>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f5f6f8; color: #5b6472; margin: 0; line-height: 1.65; }
  header, footer { max-width: 720px; margin: 0 auto; padding: 24px; }
  main { max-width: 720px; margin: 0 auto; padding: 0 24px 48px; background: #fff; }
  .wordmark { font-family: Georgia, serif; font-weight: 700; font-size: 20px; color: #14171f; text-decoration: none; }
  .wordmark .dot { color: #ff5630; }
  a { color: #ff5630; }
  h1 { font-family: Georgia, serif; color: #14171f; font-size: 32px; margin-bottom: 8px; line-height: 1.25; }
  .subtitle { color: #5b6472; font-size: 16px; margin-top: 0; margin-bottom: 24px; }
  ul { padding-left: 0; list-style: none; }
  li { margin-bottom: 18px; }
  li a { font-family: Georgia, serif; font-weight: 700; color: #14171f; text-decoration: none; }
  li a:hover { color: #ff5630; }
  li span { display: block; font-size: 14px; }
</style>
<script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
</script>
</head>
<body>
<header><a class="wordmark" href="/">LazyRelay<span class="dot">.</span></a></header>
<main>
  <h1>LazyRelay compared with other schedulers</h1>
  <p class="subtitle">Pricing, platform coverage and independent post verification, one tool at a time.</p>
  <ul>
${items.map((x) => `    <li><a href="/alternatives/${x.slug}/">${esc(x.title)}</a><span>${esc(x.description)}</span></li>`).join("\n")}
  </ul>
</main>
<footer><p><a href="/">LazyRelay home</a> &middot; <a href="/pricing/">Pricing</a></p></footer>
</body>
</html>
`;
writeFileSync(join(root, "index.html"), page);
console.log(`alternatives hub written: ${items.length} comparison pages`);
