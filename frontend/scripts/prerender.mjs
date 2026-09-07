// Prerenders a fixed set of public, no-auth routes into their own
// dist/<route>/index.html after the normal Vite build, so a crawler that
// never executes JavaScript (many AI-search bots, per the real gap found
// 2026-08-25: raw HTML for "/" was just <div id="root"></div>, nothing
// else) still sees the real content instead of an empty page.
//
// Originally scoped to "/" only. Extended 2026-09-07 to also cover
// /privacy, /terms, /dpa: those three used to be served by hand-typed
// static HTML files in frontend/public/{route}/index.html, kept in sync
// with PrivacyPolicy.tsx/TermsOfService.tsx/DPA.tsx by hand -- and one of
// them (the /dpa mirror) was found stale the very first time it mattered
// (a real POPIA compliance addition shipped to the React page and silently
// never reached the file a plain `curl` actually sees). This script now
// generates all four straight from the live rendered component instead,
// so there is no hand-maintained copy left to drift. The old static files
// under public/{privacy,terms,dpa}/ have been deleted -- this script's
// dist/<route>/index.html output is now the only source for those routes'
// non-JS content, regenerated fresh on every build.
//
// Scoped to these four routes, deliberately -- each is a real page every
// crawler/real visitor can hit directly, has no per-user data, and (for
// the legal three) no interactive elements. The dashboard and every other
// authenticated route are untouched; they still render however they
// always have.
//
// Tried extending this same technique to "/login" and "/signup" too
// (2026-08-26, Browser-Aware Web Design audit flagged the same blank-flash
// problem there for a fresh/ad-driven visit) and hit a real, structural
// blocker worth recording so a future session doesn't re-attempt it blind:
// Login.tsx renders a live Cloudflare Turnstile widget, which (a) needs a
// fresh, per-visitor challenge session -- a stale one baked into a static
// snapshot would already be invalid by the time a real visitor saw it, and
// (b) appears to actively detect and log against headless/automated
// browsers, which is exactly what puppeteer-core (driving this very script)
// is. The actual build run threw "Prerender of /login threw errors,
// refusing to bake a broken snapshot: %c%d font-size:0;color:transparent
// NaN" -- console noise from Turnstile's own bot-detection, not a real app
// bug. Loosening the console-error safety check to ignore it would mean
// silently swallowing a genuine bot-detection signal on a security-
// sensitive auth flow, which is a worse trade than the blank-flash problem
// it would fix. Left as a real, known, unfixed gap rather than forced
// through -- see the note in src/main.tsx next to the hydration-gating
// check for the same writeup at the point it actually matters.
//
// Uses whatever Chrome is already on the machine running the build (not
// Puppeteer's own downloaded Chromium) since that download's postinstall
// script is blocked by this repo's allow-scripts policy -- reusing a real
// browser that's already there avoids needing to approve it. This runs in
// two different places with two different OSes: locally on Windows, and
// in CI on GitHub Actions' ubuntu-latest runner, which ships Google Chrome
// preinstalled at a standard Linux path -- PRERENDER_CHROME_PATH is an
// escape hatch if either ever moves.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import puppeteer from "puppeteer-core";

const DIST_DIR = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PORT = 4174;

function findChrome() {
  if (process.env.PRERENDER_CHROME_PATH) return process.env.PRERENDER_CHROME_PATH;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `No Chrome/Chromium found in any of: ${candidates.join(", ")}. Set PRERENDER_CHROME_PATH to the real path.`,
    );
  }
  return found;
}

const CHROME_PATH = findChrome();

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".woff": "font/woff", ".woff2": "font/woff2", ".json": "application/json",
  ".mp4": "video/mp4",
};

// `pristineShell` is the real Vite-built dist/index.html, captured once
// into memory before any route has written anything -- it's what every
// route (including "/" itself) actually gets served here for its
// document request, mirroring the real production Apache config: serve a
// real static asset if one exists (JS/CSS/images/fonts), otherwise fall
// back to the SPA shell so React can boot and client-route off the
// pathname. Serving it from memory rather than re-reading dist/index.html
// from disk is deliberate -- once the "/" route runs and overwrites that
// file with its own prerendered output, a disk re-read would hand every
// later route an already-baked homepage instead of an empty shell.
function startStaticServer(pristineShell) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = req.url.split("?")[0];
      if (urlPath !== "/") {
        try {
          const filePath = join(DIST_DIR, decodeURIComponent(urlPath));
          const body = await readFile(filePath);
          res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
          res.end(body);
          return;
        } catch {
          // Not a real static asset -- fall through to the SPA shell below.
        }
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(pristineShell);
    });
    server.listen(PORT, () => resolve(server));
  });
}

// Each route's real content gate is a live DOM check, not a fixed timeout
// -- so a broken/blank render fails the build loudly instead of silently
// baking in a stale or empty snapshot. outDir "" means the route writes to
// dist/index.html itself (the homepage, whose own <title>/canonical are
// already correct in the built template); every other route gets its own
// dist/<outDir>/index.html, built from that same homepage template but
// with <title> and canonical swapped for the values the page's own hooks
// actually set live (so those two are sourced from the real render too,
// never hand-typed) and the homepage-only hero banner preload hint
// stripped, since it doesn't apply to any other page.
const ROUTES = [
  {
    path: "/",
    outDir: "",
    waitFor: () => document.querySelector(".landing-hero-headline")?.textContent?.includes("Schedule everywhere"),
  },
  {
    path: "/privacy",
    outDir: "privacy",
    waitFor: () => document.querySelector(".legal-page h1")?.textContent === "Privacy Policy",
  },
  {
    path: "/terms",
    outDir: "terms",
    waitFor: () => document.querySelector(".legal-page h1")?.textContent === "Terms of Service",
  },
  {
    path: "/dpa",
    outDir: "dpa",
    waitFor: () => document.querySelector(".legal-page h1")?.textContent === "Data Processing Addendum",
  },
];

async function prerenderRoute(page, pristineShell, { path, outDir, waitFor }) {
  const consoleErrors = [];
  const onPageError = (e) => consoleErrors.push(String(e));
  const onConsole = (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);

  try {
    await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(waitFor, { timeout: 15000 });

    if (consoleErrors.length > 0) {
      throw new Error(`Prerender of ${path} threw errors, refusing to bake a broken snapshot:\n${consoleErrors.join("\n")}`);
    }

    const rootHtml = await page.$eval("#root", (el) => el.innerHTML);
    const title = await page.title();
    const canonical = await page.$eval('link[rel="canonical"]', (el) => el.href).catch(() => null);

    let outPath;
    let template;
    if (outDir === "") {
      outPath = join(DIST_DIR, "index.html");
      template = pristineShell;
    } else {
      const dir = join(DIST_DIR, outDir);
      await mkdir(dir, { recursive: true });
      outPath = join(dir, "index.html");
      template = pristineShell
        .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
        .replace(/<link rel="canonical" href="[^"]*" ?\/?>/, canonical ? `<link rel="canonical" href="${canonical}" />` : "")
        // The homepage-only hero banner preload hint doesn't apply to any
        // other page and would just waste bandwidth + trigger a real
        // "preloaded but not used" browser warning on every one of them.
        .replace(/<link rel="preload" as="image"[^>]*\/>\s*/, "");
    }

    if (!template.includes('<div id="root"></div>')) {
      throw new Error(`Expected exactly <div id="root"></div> in the template for ${path} -- template changed, update this script.`);
    }
    const updated = template.replace('<div id="root"></div>', `<div id="root" data-prerendered="true">${rootHtml}</div>`);
    await writeFile(outPath, updated, "utf8");
    console.log(`Prerendered ${path} written to ${outPath} (${rootHtml.length} chars)`);
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
  }
}

async function main() {
  // Captured once, before the server starts or any route writes -- see
  // startStaticServer()'s and prerenderRoute()'s comments for why this
  // single in-memory copy (never re-read from disk) is what keeps every
  // route's render and every route's output template correct regardless
  // of write order.
  const pristineShell = await readFile(join(DIST_DIR, "index.html"), "utf8");
  const server = await startStaticServer(pristineShell);
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true });
  try {
    const page = await browser.newPage();
    for (const route of ROUTES) {
      await prerenderRoute(page, pristineShell, route);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("Prerender failed:", err);
  process.exit(1);
});
