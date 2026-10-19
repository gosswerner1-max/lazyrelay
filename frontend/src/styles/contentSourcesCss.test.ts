/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Vitest hands back an empty string for .css imports, so the files are read directly.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const css = read("./content-sources.css");
const byokCss = read("./byok-panels.css");

// Guard for the Content Sources stylesheet (Werner's locked design rules): everything scoped under .content-sources, no blue,
// no new colour tokens, only the existing byok-panels tokens, and the Apple fallbacks present.

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selector: string;
  body: string;
  media: string | null;
}

function rules(src: string): Rule[] {
  const text = strip(src);
  const out: Rule[] = [];
  function walk(start: number, end: number, media: string | null) {
    let i = start;
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open === -1 || open >= end) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < end && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const inner = text.slice(open + 1, j - 1);
      if (head.startsWith("@media") || head.startsWith("@supports")) walk(open + 1, j - 1, head);
      else out.push({ selector: head.replace(/\s+/g, " "), body: inner, media });
      i = j;
    }
  }
  walk(0, text.length, null);
  return out;
}

const all = rules(css);

// ---- colour maths ----
function hueAndChroma(r: number, g: number, b: number): { hue: number; chroma: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { hue: h, chroma: d / 255 };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function rgbOf(token: string): [number, number, number] | null {
  const t = token.trim().toLowerCase();
  let m = t.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  m = t.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = t.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
  return null;
}

// A colour counts as blue when it is clearly tinted (chroma of 12% or more) with a hue of 190 to 260 degrees.
const BLUE_HUE_MIN = 190;
const BLUE_HUE_MAX = 260;
const TINT_CHROMA = 0.12;
function isBlue(rgb: [number, number, number]): boolean {
  const { hue, chroma } = hueAndChroma(...rgb);
  return chroma >= TINT_CHROMA && hue >= BLUE_HUE_MIN && hue <= BLUE_HUE_MAX;
}

const COLOUR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const text = strip(css);

describe("colour maths self-check (so the guard itself cannot go blind)", () => {
  it("flags blues and passes warm and neutral colours", () => {
    for (const blue of ["#0000ff", "#1e90ff", "#3b82f6", "rgb(30, 64, 175)", "hsl(210, 80%, 50%)", "hsl(190 90% 40%)", "#5d6c8c"]) {
      const rgb = rgbOf(blue)!;
      expect(isBlue(rgb), blue).toBe(true);
    }
    for (const fine of ["#ff5630", "#c82400", "#4fd69c", "#ff8a7a", "#ffffff", "#000", "rgba(255,255,255,0.3)", "hsl(12, 100%, 60%)", "#eef0f5"]) {
      const rgb = rgbOf(fine)!;
      expect(isBlue(rgb), fine).toBe(false);
    }
  });
});

describe("content-sources.css", () => {
  it("has rules, and every selector sits under .content-sources", () => {
    expect(all.length).toBeGreaterThan(10);
    for (const r of all) {
      for (const part of r.selector.split(",").map((s) => s.trim())) {
        expect(part, `selector: ${part}`).toMatch(/^\.content-sources([\s.:[>+~#]|$)/);
      }
    }
  });

  it("uses no @keyframes, no @import and no :root, body or bare element rules", () => {
    expect(text).not.toMatch(/@keyframes|@import|:root|(^|[}\s,])body\s*[{,]/);
  });

  it("contains no blue: no hex, rgb or hsl colour with a blue hue, and not the word blue", () => {
    expect(css.toLowerCase()).not.toContain("blue");
    const found = text.match(COLOUR_RE) ?? [];
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) {
      const rgb = rgbOf(c);
      expect(rgb, `could not read colour ${c}`).not.toBeNull();
      expect(isBlue(rgb!), `blue colour ${c}`).toBe(false);
    }
  });

  it("adds no new colour tokens and uses only tokens that exist in byok-panels.css", () => {
    // A custom property declaration starts after { or ; (a selector such as .cs-btn--x:hover must not count).
    expect(text).not.toMatch(/[{;]\s*--[a-z0-9-]+\s*:/i);
    const used = [...new Set([...text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(0);
    const defined = new Map([...strip(byokCss).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => [m[1], m[2].trim()]));
    for (const name of used) {
      expect(defined.has(name), `${name} is not defined in byok-panels.css`).toBe(true);
    }
  });

  it("uses only tokens whose own colour is not blue either", () => {
    const defined = new Map([...strip(byokCss).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => [m[1], m[2].trim()]));
    const used = [...new Set([...text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]))];
    for (const name of used) {
      const first = (defined.get(name)!.match(COLOUR_RE) ?? [])[0];
      if (!first) continue; // not a colour (a shadow stack is read by its first colour above, a size has none)
      expect(isBlue(rgbOf(first)!), `${name} = ${defined.get(name)}`).toBe(false);
    }
  });

  it("has no em or en dash anywhere", () => {
    expect(css).not.toMatch(/[–—]/);
  });

  it("animates only transform and opacity, never layout, and never 'all'", () => {
    const declarations = [...text.matchAll(/transition\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(declarations.length).toBeGreaterThan(0);
    for (const d of declarations) {
      if (d === "none") continue;
      for (const part of d.split(/,(?![^(]*\))/)) {
        expect(part.trim().split(/\s+/)[0], `transition: ${d}`).toMatch(/^(transform|opacity)$/);
      }
    }
    expect(text).not.toMatch(/transition-property\s*:[^;]*(?!transform|opacity)\b(width|height|margin|padding|top|left|all)\b/);
  });

  it("gives plain presses instant feedback: :active scale(0.97), 100 ms ease-out", () => {
    const active = all.filter((r) => /:active/.test(r.selector) && !r.media);
    expect(active.length).toBeGreaterThan(0);
    expect(active.some((r) => /transform\s*:\s*scale\(0?\.97\)/.test(r.body))).toBe(true);
    expect(text).toMatch(/transition\s*:\s*transform 100ms ease-out/);
  });

  it("has the reduced motion, reduced transparency and more contrast fallbacks", () => {
    const medias = new Set(all.map((r) => r.media).filter(Boolean));
    expect([...medias].some((m) => /prefers-reduced-motion:\s*reduce/.test(m!))).toBe(true);
    expect([...medias].some((m) => /prefers-reduced-transparency:\s*reduce/.test(m!))).toBe(true);
    expect([...medias].some((m) => /prefers-contrast:\s*more/.test(m!))).toBe(true);
    const reduced = all.filter((r) => /prefers-reduced-motion/.test(r.media ?? ""));
    expect(reduced.some((r) => /transition\s*:\s*none/.test(r.body) || /transform\s*:\s*none/.test(r.body))).toBe(true);
  });

  it("keeps the table scrollable on narrow screens", () => {
    expect(all.some((r) => /overflow-x\s*:\s*auto/.test(r.body))).toBe(true);
  });

  it("has a visible keyboard focus ring", () => {
    expect(all.some((r) => /:focus-visible/.test(r.selector) && /outline\s*:/.test(r.body))).toBe(true);
  });
});

// The key section, the proof panel and the sources list use classes of their own. Each one must be styled here (so none falls
// back on the browser's plain look), and the new surfaces must keep the same fallbacks as the old ones.
describe("content-sources.css covers every class the tab's components use", () => {
  const files = [
    "../components/dashboard/ContentSourcesTab.tsx",
    "../components/dashboard/ContentSourcesKey.tsx",
    "../components/dashboard/ContentSourcesAddForm.tsx",
    "../components/dashboard/ContentSourcesProof.tsx",
    "../components/dashboard/ContentSourcesList.tsx",
    "../components/dashboard/ContentSourcesParts.tsx",
  ];
  const used = new Set<string>();
  for (const f of files) {
    for (const m of read(f).matchAll(/["'`]((?:[^"'`]*\s)?cs-[\w\s${}?:.()-]*)["'`]/g)) {
      for (const cls of m[1]!.matchAll(/cs-[a-z0-9_-]*[a-z0-9]/g)) used.add(cls[0]); // a class built from a variable ends in -- and is covered by the badge test below
    }
  }
  const styled = new Set([...text.matchAll(/\.(cs-[a-z0-9_-]+)/g)].map((m) => m[1]!));

  it("finds the classes the components use", () => {
    expect(used.size).toBeGreaterThan(25);
    for (const must of ["cs-method", "cs-code", "cs-btn--link", "cs-segment--disabled", "cs-copy", "cs-key-saved", "cs-reasons", "cs-note", "cs-check", "cs-proof"]) {
      expect(used.has(must), `${must} is not used by a component`).toBe(true);
    }
  });

  it("styles every one of them", () => {
    for (const cls of used) expect(styled.has(cls), `.${cls} has no rule in content-sources.css`).toBe(true);
  });

  it("keeps long proof text from breaking the layout: code wraps and the page never scrolls sideways", () => {
    const code = all.filter((r) => /\.cs-code\b/.test(r.selector) && !r.media).map((r) => r.body).join(";");
    expect(code).toMatch(/overflow-wrap\s*:\s*anywhere/);
    expect(code).toMatch(/font-family\s*:\s*(ui-monospace|monospace|var\(--byok-mono)/);
  });

  it("gives the link style button press feedback like the other buttons, and a disabled look for CSV", () => {
    const sel = (re: RegExp) => all.filter((r) => re.test(r.selector));
    expect(sel(/\.cs-btn--link/).length).toBeGreaterThan(0);
    expect(sel(/\.cs-segment--disabled/).some((r) => /cursor\s*:\s*not-allowed/.test(r.body) && /opacity\s*:/.test(r.body))).toBe(true);
  });

  it("includes the new surfaces in the reduced transparency and more contrast fallbacks", () => {
    const inMedia = (re: RegExp) => all.filter((r) => re.test(r.media ?? "")).map((r) => r.selector).join(",");
    expect(inMedia(/prefers-contrast:\s*more/)).toMatch(/\.cs-code/);
    expect(inMedia(/prefers-contrast:\s*more/)).toMatch(/\.cs-btn--link/);
    expect(inMedia(/prefers-reduced-motion/)).toMatch(/\.cs-btn/);
    expect(inMedia(/prefers-reduced-transparency/)).toMatch(/\.cs-card/);
  });

  it("colours the three status badges from existing tokens only (warm for waiting, green for verified, red for attention)", () => {
    const body = (cls: string) => all.filter((r) => r.selector.includes(cls)).map((r) => r.body).join(";");
    expect(body(".cs-badge--ok")).toMatch(/var\(--byok-ok\)/);
    expect(body(".cs-badge--attention")).toMatch(/var\(--byok-error\)/);
    expect(body(".cs-badge--wait")).toMatch(/var\(--byok-coral\)|var\(--byok-muted\)/);
  });
});
