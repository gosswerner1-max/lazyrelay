#!/usr/bin/env node
// Gives every static page under public/ a description, a canonical link and basic JSON-LD when it has none.   (2026-10-08, SEO sweep)
// Idempotent: a page that already has the thing is left alone. Only touches <head>. Skips 404.html and anything without a <title>.
//   node scripts/add-page-schema.mjs          apply
//   node scripts/add-page-schema.mjs --dry    list what would change
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const DRY = process.argv.includes("--dry");
const ORIGIN = "https://lazyrelay.com";
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function* walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (n === "index.html") yield p;
  }
}

let changed = 0;
for (const file of walk(PUBLIC)) {
  const rel = relative(PUBLIC, file).split(sep).join("/");
  if (rel === "index.html") continue; // the app shell is built by Vite
  let html = readFileSync(file, "utf8");
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (!title) continue;
  const path = "/" + rel.replace(/index\.html$/, "");
  const url = ORIGIN + path;
  const notes = [];
  let desc = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1];
  const inject = [];
  if (!desc) {
    const body = html.replace(/<(script|style|nav|header|footer)\b[\s\S]*?<\/\1>/gi, " ");
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(body)?.[1]?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (p && p.length > 40) {
      desc = esc(unesc(p).slice(0, 155).replace(/\s+\S*$/, "").trim() + (p.length > 155 ? "..." : ""));
      inject.push(`<meta name="description" content="${desc}" />`);
      notes.push("description");
    }
  }
  if (!/<link[^>]+rel="canonical"/i.test(html)) { inject.push(`<link rel="canonical" href="${url}" />`); notes.push("canonical"); }
  if (!/application\/ld\+json/i.test(html)) {
    const ld = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      url,
      name: unesc(title).replace(/\s*\|\s*LazyRelay\s*$/, "").trim(),
      ...(desc ? { description: unesc(desc) } : {}),
      isPartOf: { "@type": "WebSite", name: "LazyRelay", url: ORIGIN + "/" },
    };
    inject.push(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
    notes.push("schema");
  }
  if (!inject.length) continue;
  changed++;
  console.log(`${DRY ? "would change" : "changed"} ${path}: ${notes.join(", ")}`);
  if (!DRY) writeFileSync(file, html.replace(/<\/head>/i, `${inject.join("\n")}\n</head>`));
}
console.log(`${changed} page(s) ${DRY ? "would be " : ""}updated`);
