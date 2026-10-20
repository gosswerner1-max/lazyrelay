/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const css = read("./billing-mockup.css");
const byokCss = read("./byok-panels.css");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const text = strip(css);

describe("billing-mockup.css", () => {
  it("scopes every selector under .billing-mock", () => {
    const selectors = [...text.replace(/@keyframes[^{]+\{([^{}]*\{[^}]*\}\s*)+\}/g, "").matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(20);
    for (const group of selectors) for (const part of group.split(",").map((s) => s.trim())) expect(part, part).toMatch(/^\.billing-mock([\s.:[>+~#]|$)/);
  });

  it("has no @import, no :root and no body rule", () => {
    expect(text).not.toMatch(/@import|:root|(^|[}\s,])body\s*[{,]/);
  });

  it("has no blue and only the allowed literal colours", () => {
    expect(css.toLowerCase()).not.toMatch(/\bblue\b/);
    expect(text).not.toMatch(/hsla?\(/);
    const hex = (text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase());
    expect([...new Set(hex)].sort()).toEqual(["#ffb020", "#ff4d3d", "#ffffff"].sort());
    for (const c of text.match(/rgba?\([^)]*\)/g) ?? []) expect(c, c).toMatch(/^rgba\((0, 0, 0|255, 255, 255),/);
  });

  it("defines only the three status tokens and uses only existing byok tokens", () => {
    const defined = [...text.matchAll(/[{;]\s*(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]);
    expect(defined.sort()).toEqual(["--bm-green", "--bm-orange", "--bm-red"]);
    const known = new Set([...strip(byokCss).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
    for (const name of new Set([...text.matchAll(/var\(\s*(--byok-[a-z0-9-]+)/gi)].map((m) => m[1]!))) expect(known.has(name), name).toBe(true);
  });

  it("has no em or en dash", () => {
    expect(css).not.toMatch(/[–—]/);
  });

  it("animates only transform and opacity, never 'all' and never layout", () => {
    const declarations = [...text.matchAll(/transition\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim()).filter((d) => d !== "none");
    expect(declarations.length).toBeGreaterThan(0);
    for (const d of declarations) for (const part of d.split(/,(?![^(]*\))/)) expect(part.trim().split(/\s+/)[0], d).toMatch(/^(transform|opacity)$/);
  });

  it("flashes with a keyframe animation that touches only opacity and transform", () => {
    const frames = text.match(/@keyframes bm-flash\s*\{([\s\S]*?)\n\}/);
    expect(frames).not.toBeNull();
    const props = [...frames![1]!.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]!);
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) expect(p).toMatch(/^(opacity|transform)$/);
    expect([...text.matchAll(/animation\s*:/g)].length).toBeGreaterThan(0);
  });

  it("puts the flash on a ring inside a fixed-size dot so nothing shifts", () => {
    const dot = text.match(/\.bm-dot\s*\{([^}]*)\}/)![1]!;
    expect(dot).toMatch(/width:\s*0\.625rem/);
    expect(dot).toMatch(/height:\s*0\.625rem/);
    const ring = text.match(/\.bm-dot\[data-status="low"\]::after\s*\{([^}]*)\}/)![1]!;
    expect(ring).toMatch(/position:\s*absolute/);
    expect(ring).toMatch(/animation:\s*bm-flash/);
  });

  it("replaces the flash with a static ring under reduced motion, and drops the press scale", () => {
    const reduced = text.slice(text.indexOf("@media (prefers-reduced-motion"), text.indexOf("@media (prefers-reduced-transparency"));
    expect(reduced).toMatch(/\.bm-dot\[data-status="low"\]::after\s*\{[^}]*animation:\s*none[^}]*opacity:\s*1/);
    expect(reduced).toMatch(/transform:\s*none/);
  });

  it("has the short viewport rule, the narrow one-column rule and the other fallbacks", () => {
    expect(text).toMatch(/@media \(max-height: 700px\)/);
    expect(text).toMatch(/@media \(max-width: 720px\)\s*\{[^@]*\.bm-grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(text).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
    expect(text).toMatch(/@media \(prefers-contrast: more\)/);
    const transparency = text.slice(text.indexOf("@media (prefers-reduced-transparency"), text.indexOf("@media (prefers-contrast"));
    expect(transparency).toMatch(/backdrop-filter:\s*none/);
  });

  it("gives buttons press feedback within 100 ms", () => {
    expect(text).toMatch(/\.bm-btn\s*\{[^}]*transition:\s*transform 100ms ease-out/);
    expect(text).toMatch(/\.bm-btn:active\s*\{[^}]*transform:\s*scale\(0\.97\)/);
  });

  it("lets long numbers wrap and every column shrink", () => {
    expect(text).toMatch(/\.bm-total__value\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(text).toMatch(/\.bm-lot\s*\{[^}]*min-width:\s*0/);
    expect(text).toMatch(/\.bm-balance__text\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it("sets tracking and leading by size", () => {
    expect(text).toMatch(/\.bm-total__num\s*\{[^}]*letter-spacing:\s*-0\.02em/);
    expect(text).toMatch(/\.bm-lot__line\s*\{[^}]*line-height:\s*1\.5/);
    expect(text).toMatch(/\.bm-lot__title\s*\{[^}]*letter-spacing:\s*0\.0\d+em/);
  });
});
