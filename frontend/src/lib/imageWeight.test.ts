import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import aiToolIcon from "../components/AiToolIcon.tsx?raw";
import brandMark from "../components/BrandMark.tsx?raw";
import landing from "../pages/Landing.tsx?raw";
import supportWidget from "../components/SupportWidget.tsx?raw";

// Speed audit (2026-10-15): the build shipped a 186 KB support-bot-head.png and a 52 KB icon.png that are drawn at
// 28 to 44 px, plus footer badge and tool icons that load before they are needed. The two images are now small WebP
// files sized for 2x the largest size they are drawn at, and the below-the-fold images load lazily. Every one of
// those images already carries width and height, so lazy loading adds no layout shift. The hero banner stays eager.
const assets = resolve(__dirname, "../assets");
const KB = 1024;

describe("shrunk image assets", () => {
  it("support bot head is a small WebP (drawn at most 44 px tall)", () => {
    expect(existsSync(resolve(assets, "support-bot-head.webp"))).toBe(true);
    expect(statSync(resolve(assets, "support-bot-head.webp")).size).toBeLessThan(15 * KB);
    expect(existsSync(resolve(assets, "support-bot-head.png"))).toBe(false);
    expect(supportWidget).toContain('from "../assets/support-bot-head.webp?no-inline"');
  });
  it("brand icon is a small WebP (drawn at most 40 px)", () => {
    expect(existsSync(resolve(assets, "icon.webp"))).toBe(true);
    expect(statSync(resolve(assets, "icon.webp")).size).toBeLessThan(10 * KB);
    expect(existsSync(resolve(assets, "icon.png"))).toBe(false);
    expect(brandMark).toContain('from "../assets/icon.webp"');
  });
  it("the two together are a rounding error next to the 100 KB image budget", () => {
    const names = ["support-bot-head.webp", "icon.webp"];
    const total = names.reduce((sum, n) => sum + (existsSync(resolve(assets, n)) ? statSync(resolve(assets, n)).size : 1e9), 0);
    expect(total).toBeLessThan(20 * KB);
  });
});

describe("below-the-fold images load lazily without layout shift", () => {
  it("footer badge images are lazy and keep their width and height", () => {
    expect(landing).toMatch(/<img src=\{badge\.imgSrc\}[^>]*width=\{badge\.width\}[^>]*height=\{badge\.height\}[^>]*loading="lazy"/);
  });
  it("AI tool icons are lazy and keep their width and height", () => {
    expect(aiToolIcon).toMatch(/<img [^>]*width=\{size\} height=\{size\}[^>]*loading="lazy"/);
  });
  it("the hero banner is never lazy", () => {
    const hero = landing.match(/<img\s+src=\{banner\}[\s\S]*?\/>/)?.[0] ?? "";
    expect(hero).toContain("fetchPriority");
    expect(hero).not.toContain('loading="lazy"');
  });
});
