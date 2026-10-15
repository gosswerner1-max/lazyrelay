import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import landing from "../pages/Landing.tsx?raw";
import indexHtml from "../../index.html?raw";

// The home hero banner was a 259 KB JPEG, the one image over the 200 KB budget in the Site Audit (2026-10-15).
// It ships as WebP now. The hero fill colour (--hero-bg) is matched to the banner's own edge pixels, so the new file
// was checked to sit as close to rgb(4,11,29) at its edges as the original did (max deviation 8 for both).
const BUDGET_BYTES = 200_000;
const banner = resolve(__dirname, "../assets/banner.webp");

describe("home hero banner", () => {
  it("is a WebP under the 200 KB image budget", () => {
    expect(existsSync(banner)).toBe(true);
    expect(statSync(banner).size).toBeLessThan(BUDGET_BYTES);
  });
  it("is the file the page imports and preloads", () => {
    expect(landing).toContain('import banner from "../assets/banner.webp"');
    expect(indexHtml).toContain('href="/src/assets/banner.webp"');
    expect(existsSync(resolve(__dirname, "../assets/banner.jpg"))).toBe(false);
  });
});
