/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const css = read("./guided-tour.css");
const byok = read("./byok-panels.css");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const text = strip(css);

describe("guided-tour.css", () => {
  it("scopes every selector under .guided-tour", () => {
    const selectors = [...text.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(15);
    for (const group of selectors) for (const part of group.split(",").map((s) => s.trim())) expect(part, part).toMatch(/^\.guided-tour([\s.:[>+~#_-]|$)/);
  });
  it("has no @import, no :root, no body rule and no @keyframes", () => {
    expect(text).not.toMatch(/@import|:root|@keyframes|(^|[}\s,])body\s*[{,]/);
  });
  it("has no blue and only black, white and the three token fallbacks as literal colours", () => {
    expect(css.toLowerCase()).not.toMatch(/\bblue\b/);
    expect(text).not.toMatch(/hsla?\(/);
    const tokens = new Map([...strip(byok).matchAll(/(--byok-[a-z]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
    for (const hex of new Set((text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase()))) {
      expect(hex === "#ffffff" || [...tokens.values()].includes(hex), hex).toBe(true);
    }
    for (const c of text.match(/rgba?\([^)]*\)/g) ?? []) expect(c, c).toMatch(/^rgba\((0, 0, 0|255, 255, 255),/);
  });
  it("uses fallbacks that equal the existing token values", () => {
    for (const m of text.matchAll(/var\((--byok-[a-z]+),\s*(#[0-9a-fA-F]{6})\)/g)) {
      const real = byok.match(new RegExp(`${m[1]}:\\s*(#[0-9a-fA-F]{6})`));
      expect(real?.[1]?.toLowerCase(), m[1]).toBe(m[2]!.toLowerCase());
    }
  });
  it("has no em or en dash", () => {
    expect(css).not.toMatch(/[\u2013\u2014]/);
  });
  it("animates only transform and opacity, never 'all' and never layout", () => {
    const declarations = [...text.matchAll(/transition\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim()).filter((d) => d !== "none");
    expect(declarations.length).toBeGreaterThan(0);
    for (const d of declarations) for (const part of d.split(/,(?![^(]*\))/)) expect(part.trim().split(/\s+/)[0], d).toMatch(/^(transform|opacity)$/);
  });
  it("never moves the ring or the popover with a transition", () => {
    const ring = [...text.matchAll(/\.guided-tour__ring\s*\{[^}]*\}/g)].map((m) => m[0]).join("\n");
    expect(ring).not.toMatch(/transition|animation/);
    expect(ring).toMatch(/pointer-events:\s*none/);
  });
  it("gives the buttons press feedback within 100 ms", () => {
    expect(text).toMatch(/\.guided-tour__btn\s*\{[^}]*transition:\s*transform 100ms ease-out/);
    expect(text).toMatch(/\.guided-tour__btn:active:not\(:disabled\)\s*\{[^}]*transform:\s*scale\(0\.97\)/);
  });
  it("drops all movement under reduced motion but keeps the fade", () => {
    const reduced = text.slice(text.indexOf("@media (prefers-reduced-motion"), text.indexOf("@media (prefers-contrast"));
    expect(reduced).toMatch(/transform:\s*none/);
    expect(reduced).toMatch(/transition:\s*opacity/);
    expect(reduced).not.toMatch(/translate/);
  });
  it("has the more contrast and short viewport rules", () => {
    expect(text).toMatch(/@media \(prefers-contrast: more\)/);
    expect(text).toMatch(/@media \(max-height: 700px\)/);
  });
  it("sets the popover to fit a 360 px phone", () => {
    expect(text).toMatch(/\.guided-tour\s*\{[^}]*width:\s*min\(20rem,\s*calc\(100vw - 1rem\)\)/);
  });
  it("sets tracking and leading by size", () => {
    expect(text).toMatch(/\.guided-tour__title\s*\{[^}]*letter-spacing:\s*-0\.01em/);
    expect(text).toMatch(/\.guided-tour__text\s*\{[^}]*line-height:\s*1\.5/);
  });
});
