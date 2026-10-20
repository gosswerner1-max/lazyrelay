/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Vitest hands back an empty string for .css imports, so the files are read directly.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const css = read("./competitor-mode.css");
const byokCss = read("./byok-panels.css");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const text = strip(css);

// Guard for the competitor mode stylesheet: scoped under .content-sources, no blue, only existing tokens, the Apple
// rules (only transform and opacity animate, fallbacks present).

describe("competitor-mode.css", () => {
  it("scopes every selector under .content-sources", () => {
    const selectors = [...text.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(8);
    for (const group of selectors) {
      for (const part of group.split(",").map((s) => s.trim())) {
        expect(part, `selector: ${part}`).toMatch(/^\.content-sources([\s.:[>+~#]|$)/);
      }
    }
  });

  it("has no @keyframes, no @import, no :root and no body rule", () => {
    expect(text).not.toMatch(/@keyframes|@import|:root|(^|[}\s,])body\s*[{,]/);
  });

  it("has no blue and uses only black and white at partial opacity as literal colours", () => {
    expect(css.toLowerCase()).not.toContain("blue");
    expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b|hsla?\(/);
    for (const c of text.match(/rgba?\([^)]*\)/g) ?? []) expect(c, c).toMatch(/^rgba\((0, 0, 0|255, 255, 255),/);
  });

  it("adds no colour tokens and uses only tokens that exist in byok-panels.css", () => {
    expect(text).not.toMatch(/[{;]\s*--[a-z0-9-]+\s*:/i);
    const defined = new Set([...strip(byokCss).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
    const used = [...new Set([...text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]!))];
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(defined.has(name), `${name} is not defined in byok-panels.css`).toBe(true);
  });

  it("has no em or en dash anywhere", () => {
    expect(css).not.toMatch(/[\u2013\u2014]/);
  });

  it("animates only transform and opacity, never 'all' and never layout", () => {
    const declarations = [...text.matchAll(/transition\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(declarations.length).toBeGreaterThan(0);
    for (const d of declarations) {
      for (const part of d.split(/,(?![^(]*\))/)) {
        expect(part.trim().split(/\s+/)[0], `transition: ${d}`).toMatch(/^(transform|opacity)$/);
      }
    }
  });

  it("makes the dialog enter and leave on the same path: one closed state and one open state, the same timing both ways", () => {
    const card = text.match(/\.cs-modal__card\s*\{[^}]*\}/)![0];
    expect(card).toMatch(/transform:\s*scale\(0\.9\d\)/);
    expect(card).toMatch(/transition:[^;]*transform 160ms ease-out[^;]*opacity 160ms ease-out/);
    expect(text).toMatch(/\.cs-modal\[data-state="open"\] \.cs-modal__card\s*\{[^}]*transform:\s*scale\(1\)/);
  });

  it("has the reduced motion, reduced transparency and more contrast fallbacks", () => {
    expect(text).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(text).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
    expect(text).toMatch(/@media \(prefers-contrast: more\)/);
    const reduced = text.slice(text.indexOf("@media (prefers-reduced-motion"), text.indexOf("@media (prefers-reduced-transparency"));
    expect(reduced).toMatch(/transform:\s*none/);
    const transparency = text.slice(text.indexOf("@media (prefers-reduced-transparency"), text.indexOf("@media (prefers-contrast"));
    expect(transparency).toMatch(/backdrop-filter:\s*none/);
  });

  it("styles every cs- class the competitor components add", () => {
    const files = ["CompetitorPanel.tsx", "CompetitorResult.tsx", "CompetitorConsentDialog.tsx"].map((f) => read(`../components/dashboard/${f}`)).join("\n");
    const base = strip(read("./content-sources.css")) + text;
    const used = new Set([...files.matchAll(/"((?:[^"]*\s)?cs-[\w\s-]*)"/g)].flatMap((m) => [...m[1]!.matchAll(/cs-[a-z0-9_-]*[a-z0-9]/g)].map((c) => c[0])));
    expect(used.size).toBeGreaterThan(15);
    for (const cls of used) expect(base, `.${cls} has no rule`).toContain(`.${cls}`);
  });
});

// The status panel's stylesheet gets the same basic guard: scoped, existing tokens only, no blue, no dashes, nothing animated.
describe("content-sources-status.css", () => {
  const status = read("./content-sources-status.css");
  const body = strip(status);

  it("scopes every selector under .content-sources", () => {
    const selectors = [...body.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(5);
    for (const group of selectors) for (const part of group.split(",")) expect(part.trim(), part).toMatch(/^\.content-sources([\s.:[>+~#]|$)/);
  });

  it("uses only existing tokens, no literal colours, no blue, no dashes, no animation", () => {
    const defined = new Set([...strip(byokCss).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
    const used = [...new Set([...body.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]!))];
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(defined.has(name), name).toBe(true);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|transition|animation|@keyframes/);
    expect(status.toLowerCase()).not.toContain("blue");
    expect(status).not.toMatch(/[\u2013\u2014]/);
  });
});
