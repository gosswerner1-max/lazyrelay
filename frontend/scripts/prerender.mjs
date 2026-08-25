// Prerenders the public homepage ("/") into dist/index.html after the
// normal Vite build, so a crawler that never executes JavaScript (many
// AI-search bots, per the real gap found 2026-08-25: raw HTML for "/" was
// just <div id="root"></div>, nothing else) still sees the real marketing
// content instead of an empty page.
//
// Scoped to "/" only, deliberately -- it's the one page every crawler and
// every real visitor hits, has no per-user data, and is the exact page the
// gap was found on. The dashboard and every other authenticated route are
// untouched; they still render however they always have.
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
import { readFile, writeFile } from "node:fs/promises";
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

function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
        const filePath = join(DIST_DIR, decodeURIComponent(urlPath));
        const body = await readFile(filePath);
        res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function main() {
  const server = await startStaticServer();
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    // Real content gate, not a fixed timeout -- waits for the actual
    // headline text Landing.tsx renders, so this fails loudly instead of
    // silently baking in a blank/loading snapshot if something regresses.
    await page.waitForFunction(
      () => document.querySelector(".landing-hero-headline")?.textContent?.includes("Schedule everywhere"),
      { timeout: 15000 },
    );

    if (consoleErrors.length > 0) {
      throw new Error(`Prerender page threw errors, refusing to bake a broken snapshot:\n${consoleErrors.join("\n")}`);
    }

    const rootHtml = await page.$eval("#root", (el) => el.innerHTML);
    const indexPath = join(DIST_DIR, "index.html");
    const indexHtml = await readFile(indexPath, "utf8");
    if (!indexHtml.includes('<div id="root"></div>')) {
      throw new Error('Expected exactly <div id="root"></div> in dist/index.html -- template changed, update this script.');
    }
    const updated = indexHtml.replace('<div id="root"></div>', `<div id="root" data-prerendered="true">${rootHtml}</div>`);
    await writeFile(indexPath, updated, "utf8");
    console.log(`Prerendered homepage written to ${indexPath} (${rootHtml.length} chars)`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("Prerender failed:", err);
  process.exit(1);
});
