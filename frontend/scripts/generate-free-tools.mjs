// Regenerates the rules data embedded in the free tools pages.
//
// Usage (from anywhere):  node frontend/scripts/generate-free-tools.mjs
//
// It runs TypeScript from backend/ with `npx tsx` to load
//   backend/src/platformRules.ts (text limits, media rules, notes)
//   backend/src/carousel.ts      (multi-item rules, via MULTI_MEDIA_RULES)
// (mediaLimits.ts numbers reach platformRules.ts through its own copied values),
// then writes a JSON block into frontend/public/free-tools/post-checker/index.html
// between the RULES-DATA markers. Nothing is typed by hand: a limit that is null
// in platformRules.ts stays null here and the page says "no published limit that
// we could verify".
//
// Also checks free-tools-manifest.json (description under 160 chars, no dashes).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const backend = join(repo, "backend");
const pagePath = join(repo, "frontend", "public", "free-tools", "post-checker", "index.html");
const manifestPath = join(here, "free-tools-manifest.json");

// The 17 platforms of the checker, in display order (X is deliberately not included).
export const PLATFORM_ORDER = [
  "facebook", "instagram", "tiktok", "pinterest", "youtube", "linkedin", "threads", "mastodon",
  "bluesky", "telegram", "discord", "tumblr", "wordpress", "devto", "hashnode", "lemmy", "slack",
];

const DASH = /[\u2013\u2014]/;

function dumpRules() {
  const dir = mkdtempSync(join(tmpdir(), "lr-free-tools-"));
  const tmp = join(dir, "dump.ts");
  const rulesUrl = pathToFileURL(join(backend, "src", "platformRules.ts")).href;
  const carouselUrl = pathToFileURL(join(backend, "src", "carousel.ts")).href;
  writeFileSync(
    tmp,
    `import { getPlatformRules } from ${JSON.stringify(rulesUrl)};\n` +
      `import { MULTI_MEDIA_RULES } from ${JSON.stringify(carouselUrl)};\n` +
      `process.stdout.write("@@JSON@@" + JSON.stringify({ rules: getPlatformRules(), carousel: MULTI_MEDIA_RULES }));\n`,
  );
  try {
    const r = spawnSync("npx", ["tsx", tmp], { cwd: backend, shell: true, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
      // Placeholders only: importing the rules pulls in modules that refuse to load without them. Nothing connects.
      env: { ...process.env, SUPABASE_URL: process.env.SUPABASE_URL || "https://placeholder.invalid", SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder" } });
    if (r.status !== 0) throw new Error("tsx failed: " + (r.stderr || r.stdout));
    const i = r.stdout.indexOf("@@JSON@@");
    if (i < 0) throw new Error("no JSON in tsx output: " + r.stdout.slice(0, 300));
    return JSON.parse(r.stdout.slice(i + 8));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function buildData(dump) {
  const byId = new Map(dump.rules.map((r) => [r.platform, r]));
  const platforms = PLATFORM_ORDER.map((id) => {
    const r = byId.get(id);
    if (!r) throw new Error("platform missing from platformRules.ts: " + id);
    const note = r.text.note;
    // How the platform counts text, only where the repo note says so.
    let countMode = "length";
    if (/UTF-16/.test(note)) countMode = "utf16";
    else if (/graphemes/.test(note)) countMode = "graphemes";
    else if (r.text.maxLength !== null && note.includes("(" + r.text.maxLength + " bytes")) countMode = "bytes";
    // Lemmy's limit is for the title (first line of the post).
    const limitScope = /^Title:/.test(note) ? "firstLine" : "whole";
    // Telegram: a caption limit applies when media is attached (from the repo note).
    let captionMaxLength = null;
    const cap = note.match(/caption of at most (\d+) characters/);
    if (cap) captionMaxLength = Number(cap[1]);
    // Multi-item rule comes from carousel.ts directly; it must agree with platformRules.ts.
    const c = dump.carousel[id] || null;
    const fromRules = r.media.multiItem;
    if (JSON.stringify(c ? { maxItems: c.max, videosAllowed: c.videos } : null) !== JSON.stringify(fromRules)) {
      throw new Error("carousel.ts and platformRules.ts disagree for " + id);
    }
    return {
      platform: id,
      label: r.label,
      text: { maxLength: r.text.maxLength, note, countMode, limitScope, captionMaxLength },
      media: {
        textOnlyAllowed: r.media.textOnlyAllowed,
        imageSupported: r.media.image.supported,
        videoSupported: r.media.video.supported,
        multiItem: fromRules,
        notes: r.media.notes,
      },
      sources: r.sources,
    };
  });
  for (const p of platforms) {
    const all = JSON.stringify(p);
    if (DASH.test(all)) throw new Error("em/en dash found in rules data for " + p.platform);
  }
  return { platforms };
}

function checkManifest() {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const e of m) {
    if (!e.slug || !e.url || !e.title || !e.description) throw new Error("manifest entry incomplete: " + JSON.stringify(e));
    if (e.description.length >= 160) throw new Error("meta description too long (" + e.description.length + "): " + e.slug);
    if (DASH.test(JSON.stringify(e))) throw new Error("dash in manifest: " + e.slug);
  }
}

function embed(data) {
  const START = "<!--RULES-DATA-START-->";
  const END = "<!--RULES-DATA-END-->";
  const html = readFileSync(pagePath, "utf8");
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < a) throw new Error("markers not found in " + pagePath);
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const block = `${START}<script type="application/json" id="rules-data">${json}</script>${END}`;
  writeFileSync(pagePath, html.slice(0, a) + block + html.slice(b + END.length));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkManifest();
  const data = buildData(dumpRules());
  embed(data);
  const unverified = data.platforms.filter((p) => p.text.maxLength === null).map((p) => p.label);
  console.log(`Embedded ${data.platforms.length} platforms into ${pagePath}`);
  console.log("No verified text limit in platformRules.ts: " + unverified.join(", "));
}
