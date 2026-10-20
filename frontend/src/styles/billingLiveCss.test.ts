/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const css = read("./billing-live.css");
const byokCss = read("./byok-panels.css");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const text = strip(css);

describe("billing-live.css", () => {
  it("scopes every selector under .billing-mock", () => {
    const selectors = [...text.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(15);
    for (const group of selectors) for (const part of group.split(",").map((s) => s.trim())) expect(part, part).toMatch(/^\.billing-mock([\s.:[>+~#]|$)/);
  });

  it("has no @import, no :root, no body rule and no new custom property", () => {
    expect(text).not.toMatch(/@import|:root|(^|[}\s,])body\s*[{,]/);
    expect([...text.matchAll(/[{;]\s*(--[a-z0-9-]+)\s*:/gi)]).toHaveLength(0);
  });

  it("has no blue and only the allowed literal colours", () => {
    expect(css.toLowerCase()).not.toMatch(/\bblue\b/);
    expect(text).not.toMatch(/hsla?\(|#[0-9a-fA-F]{3,8}\b/);
    for (const c of text.match(/rgba?\([^)]*\)/g) ?? []) expect(c, c).toMatch(/^rgba\((0, 0, 0|255, 255, 255),/);
  });

  it("uses only tokens that exist", () => {
    const known = new Set([...strip(byokCss).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
    for (const name of new Set([...text.matchAll(/var\(\s*(--byok-[a-z0-9-]+)/gi)].map((m) => m[1]!))) expect(known.has(name), name).toBe(true);
    for (const name of new Set([...text.matchAll(/var\(\s*(--bm-[a-z]+)/gi)].map((m) => m[1]!))) expect(["--bm-red"]).toContain(name);
  });

  it("has no em or en dash", () => {
    expect(css).not.toMatch(/[\u2013\u2014]/);
  });

  it("animates nothing but transform and opacity", () => {
    expect(text).not.toMatch(/animation\s*:|transition\s*:/);
    expect(text).not.toMatch(/transition-property/);
  });

  it("lets a pressed, waiting button stay still and keeps its press feedback from billing-mockup.css", () => {
    expect(text).toMatch(/\.bm-btn:disabled:active\s*\{[^}]*transform:\s*none/);
  });

  it("has the 360 px rule: one column, full-width buttons, a smaller chip", () => {
    const phone = text.slice(text.indexOf("@media (max-width: 420px)"), text.indexOf("@media (max-height: 700px)"));
    expect(phone).toMatch(/\.bm-buy__list\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(phone).toMatch(/\.bm-buy \.bm-btn\s*\{[^}]*width:\s*100%/);
    expect(phone).toMatch(/\.bm-chip/);
  });

  it("has the short-window rule for 1366x600 and 1280x560", () => {
    expect(text).toMatch(/@media \(max-height: 700px\)/);
  });

  it("has the reduced transparency and more contrast fallbacks", () => {
    expect(text).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
    expect(text).toMatch(/@media \(prefers-contrast: more\)/);
  });

  it("lets long text wrap and every column shrink", () => {
    expect(text).toMatch(/\.bm-buy__item\s*\{[^}]*min-width:\s*0/);
    expect(text).toMatch(/\.bm-buy__item\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(text).toMatch(/\.bm-plan\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it("sets tracking by size: tight on the big price, open on the small name", () => {
    expect(text).toMatch(/\.bm-buy__price\s*\{[^}]*letter-spacing:\s*-0\.015em/);
    expect(text).toMatch(/\.bm-buy__name\s*\{[^}]*letter-spacing:\s*0\.02em/);
    expect(text).toMatch(/\.bm-buy__reason[^{]*\{[^}]*line-height:\s*1\.5/);
  });
});
