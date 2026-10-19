#!/usr/bin/env node
// Copy guardrails for the newest comparison pages under frontend/public/alternatives/<slug>/index.html.
// Fails (exit 1) when a page's VISIBLE text holds a dash or hyphen, or when a page mentions the colour blue anywhere (text, class
// names, CSS). It also fails when a page it is told to check does not exist, so an empty folder can never pass as "clean".
// Visible text means the page with <head>, <script>, <style> and every tag and attribute removed, so URLs, meta names and CSS
// property names (which need hyphens) are not scanned, only what a reader sees.
//
// Run from the repository root:  node scripts/check-copy-guardrails.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SLUGS = ["coschedule", "socialpilot", "sendible", "zohosocial", "meetedgar", "planoly"];
const ROOT = path.join(__dirname, "..", "frontend", "public", "alternatives");

// Every way a dash can be typed or written as an entity: hyphen minus, hyphen, non breaking hyphen, figure, en, em, horizontal bar, minus.
const DASH_CHARS = /[-‐-―−]/;
const DASH_ENTITIES = /&(?:mdash|ndash|minus|hyphen|dash|horbar);|&#(?:45|8208|8209|8210|8211|8212|8213|8722|x2d|x2010|x2011|x2012|x2013|x2014|x2015|x2212);/i;

function decodeBasic(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/** The text a reader sees: the body with scripts, styles and tags removed. Entities for dashes are checked BEFORE decoding. */
function visibleText(html) {
  const body = html.includes("<body") ? html.slice(html.indexOf("<body")) : html;
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ");
}

/** Hex colours whose blue channel clearly leads the other two, so a blue can not slip in as #1a73e8 instead of the word. */
function blueHexColours(html) {
  const found = [];
  for (const m of html.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (b > r + 40 && b > g + 40) found.push(m[0]);
  }
  return found;
}

/** Returns a list of plain sentences, one per problem. Empty means the page passes. */
function checkHtml(html) {
  const problems = [];
  const raw = visibleText(html);
  if (DASH_ENTITIES.test(raw)) problems.push("a dash written as an entity in the visible text");
  const text = decodeBasic(raw);
  const hit = DASH_CHARS.exec(text);
  if (hit) {
    const at = hit.index;
    problems.push(`a dash or hyphen in the visible text near "${text.slice(Math.max(0, at - 20), at + 20).replace(/\s+/g, " ").trim()}"`);
  }
  // A whole word only: Bluesky is a real platform name and must not trip this.
  if (/\bblue\b/i.test(html)) problems.push('the word "blue" appears in the page');
  const colours = blueHexColours(html);
  if (colours.length > 0) problems.push(`a blue leaning colour in the styles: ${[...new Set(colours)].join(", ")}`);
  return problems;
}

function run(slugs = SLUGS, root = ROOT) {
  let failed = 0;
  for (const slug of slugs) {
    const file = path.join(root, slug, "index.html");
    if (!fs.existsSync(file)) {
      console.error(`Guardrail failure: ${slug} has no page at ${file}`);
      failed += 1;
      continue;
    }
    const problems = checkHtml(fs.readFileSync(file, "utf8"));
    for (const p of problems) console.error(`Guardrail violation in ${slug}: ${p}`);
    if (problems.length > 0) failed += 1;
  }
  if (failed === 0) console.log(`Copy guardrails passed for ${slugs.length} pages`);
  return failed === 0 ? 0 : 1;
}

module.exports = { SLUGS, checkHtml, visibleText, run };

if (require.main === module) process.exit(run());
