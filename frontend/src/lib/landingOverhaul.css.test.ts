/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

// Landing visual overhaul guard (2026-10-14). Reads the real App.css and inspects only the block between the
// LANDING-OVERHAUL markers, so a regression in that CSS fails here. Landing page only; dashboards are untouched.

const appCss = readFileSync(pathResolve(process.cwd(), "src/App.css"), "utf8");
const START = "/* LANDING-OVERHAUL:START */";
const END = "/* LANDING-OVERHAUL:END */";
const startIdx = appCss.indexOf(START);
const endIdx = appCss.indexOf(END);
const block = startIdx >= 0 && endIdx > startIdx ? appCss.slice(startIdx + START.length, endIdx) : "";

interface Rule {
  selector: string;
  body: string;
  ctx: string[];
}

function parse(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  function walk(ctx: string[]): Rule[] {
    const out: Rule[] = [];
    while (i < src.length) {
      const start = i;
      while (i < src.length && src[i] !== "{" && src[i] !== "}") i++;
      if (i >= src.length || src[i] === "}") return out;
      const selector = src.slice(start, i).trim().replace(/\s+/g, " ");
      i++;
      if (selector.startsWith("@media") || selector.startsWith("@supports")) {
        out.push(...walk([...ctx, selector]));
        i++;
      } else {
        const b = i;
        while (i < src.length && src[i] !== "}") i++;
        out.push({ selector, body: src.slice(b, i), ctx });
        i++;
      }
    }
    return out;
  }
  return walk([]);
}

const rules = parse(block);
const decl = (body: string, prop: string) => body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`))?.[1].trim();
// Every landing rule is scoped to the home page only: legal pages, Partners and the docs share the .landing wrapper.
const SCOPE = ".landing:has(.landing-hero)";
const rawSelectors = (r: Rule) => r.selector.split(",").map((s) => s.trim());
const strip = (s: string) => (s === SCOPE ? "" : s.startsWith(SCOPE + " ") ? s.slice(SCOPE.length + 1) : s);
const selectorsOf = (r: Rule) => rawSelectors(r).map(strip);
const inCtx = (r: Rule, re: RegExp) => r.ctx.some((c) => re.test(c));
const baseRules = rules.filter((r) => r.ctx.length === 0);

// ---- tokens ---------------------------------------------------------------------------------------------------
const rootRule = rules.find((r) => r.selector === ":root" && r.ctx.length === 0);
const tokens: Record<string, string> = {};
for (const m of (rootRule?.body ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();

function resolve(value: string | undefined, depth = 0): string {
  if (!value) return "";
  if (depth > 6) return value;
  return value.replace(/var\((--[\w-]+)\)/g, (_, n) => resolve(tokens[n] ?? "", depth + 1));
}

const REQUIRED_TOKENS = [
  "--lz-bg",
  "--lz-hero",
  "--lz-surface-top",
  "--lz-surface-bottom",
  "--lz-card-top",
  "--lz-card-bottom",
  "--lz-text",
  "--lz-text-muted",
  "--lz-brand-text",
  "--lz-border",
  "--lz-highlight",
  "--lz-field-bg",
  "--lz-field-border",
  "--lz-metal-from",
  "--lz-metal-to",
  "--lz-electric",
  "--lz-electric-bright",
  "--lz-cyan",
  "--lz-electric-ring",
  "--lz-electric-glow",
  "--lz-shadow-card",
  "--lz-shadow-heavy",
];

describe("design tokens", () => {
  it("the overhaul block exists", () => {
    expect(startIdx, "missing start marker").toBeGreaterThanOrEqual(0);
    expect(endIdx, "missing end marker").toBeGreaterThan(startIdx);
  });
  it("every token is defined on :root", () => {
    for (const t of REQUIRED_TOKENS) expect(tokens[t], `${t} missing from :root`).toBeTruthy();
  });
});

// ---- elevation ------------------------------------------------------------------------------------------------
const CARDS = [".landing-step", ".landing-feature", ".landing-bento-tile", ".faq-item", ".pricing-card", ".landing-proof-item"];
const HEAVY = [".pricing-card", ".landing-newsletter", ".comparison-table"];
const FORMS = [".newsletter-form input"];
const ELEVATED = [...CARDS, ...HEAVY, ...FORMS];
const ruleFor = (sel: string, ctx0 = true) =>
  rules.find((r) => (ctx0 ? r.ctx.length === 0 : true) && selectorsOf(r).includes(sel) && /box-shadow|(^|[;\s])border\s*:/.test(r.body) && !selectorsOf(r).some((x) => x.includes(":")));

describe("component elevation", () => {
  for (const sel of ELEVATED) {
    it(`${sel}: 1px translucent border, layered shadow, inset top highlight`, () => {
      const r = ruleFor(sel);
      expect(r, `no base rule for ${sel}`).toBeDefined();
      const border = resolve(decl(r!.body, "border"));
      expect(border, `${sel} border`).toMatch(/^1px solid /);
      if (!FORMS.includes(sel)) expect(border, `${sel} border must be translucent`).toMatch(/rgba\(/);
      const shadow = resolve(decl(r!.body, "box-shadow"));
      const layers = shadow.split(/,(?![^(]*\))/).length;
      expect(layers, `${sel} shadow layers`).toBeGreaterThanOrEqual(3);
      expect(shadow, `${sel} inset top highlight`).toMatch(/inset 0 1px 0/);
    });
  }

  it("cards and panels use a blurred translucent material; heavier surfaces blur more than small ones", () => {
    const blur = (sel: string) => Number(/blur\((\d+)px\)/.exec(decl(ruleFor(sel)!.body, "backdrop-filter") ?? "")?.[1] ?? 0);
    for (const sel of [...CARDS, ...HEAVY]) expect(blur(sel), `${sel} backdrop blur`).toBeGreaterThan(0);
    expect(blur(".pricing-card")).toBeGreaterThan(blur(".landing-step"));
    expect(blur(".landing-newsletter")).toBeGreaterThan(blur(".landing-step"));
  });

  it("cards carry a faint top sheen layered into the background", () => {
    for (const sel of CARDS) expect(decl(ruleFor(sel)!.body, "background"), sel).toMatch(/linear-gradient\(180deg, rgba\(255, 255, 255, 0?\.0\d+\)/);
  });
});

// ---- electric accents -----------------------------------------------------------------------------------------
const ELECTRIC = /var\(--lz-(electric|cyan)[\w-]*\)/;
const INTERACTIVE = /:(hover|focus-visible|focus-within|active)/;

describe("electric accents are interaction-only", () => {
  it("no plain selector uses an electric token, except dormant (opacity: 0) glow pseudo-elements", () => {
    // a pseudo-element selector is dormant when its base rule is opacity: 0 (fallback rules for it stay invisible too)
    const dormant = new Set(
      baseRules.filter((r) => /::(after|before)/.test(r.selector) && /(^|[;\s])opacity:\s*0\s*(;|$)/.test(r.body)).map((r) => r.selector),
    );
    const offenders = rules
      .filter((r) => r.selector !== ":root" && ELECTRIC.test(r.body) && !INTERACTIVE.test(r.selector))
      .filter((r) => !dormant.has(r.selector))
      .map((r) => r.selector);
    expect(offenders, "electric tokens in non-interactive selectors").toEqual([]);
  });

  it("electric tokens are never used as a static fill or text colour", () => {
    for (const r of baseRules.filter((x) => x.selector !== ":root")) {
      expect(decl(r.body, "color") ?? "", r.selector).not.toMatch(ELECTRIC);
      expect(decl(r.body, "background") ?? "", r.selector).not.toMatch(ELECTRIC);
      expect(decl(r.body, "background-color") ?? "", r.selector).not.toMatch(ELECTRIC);
    }
  });

  it("the brand CTA fill is not redefined by the overhaul", () => {
    for (const r of rules) {
      if (selectorsOf(r).some((s) => s === ".cta" || s.startsWith(".landing-hero .cta"))) {
        expect(r.body).not.toMatch(/background(-color)?\s*:/);
      }
    }
  });
});

// ---- micro-states ---------------------------------------------------------------------------------------------
describe("hover and focus micro-states", () => {
  const hoverRules = rules.filter((r) => /:hover/.test(r.selector) && !inCtx(r, /prefers-reduced-motion/));
  it("there are hover rules, all inside @media (hover: hover)", () => {
    expect(hoverRules.length).toBeGreaterThan(0);
    for (const r of hoverRules) expect(inCtx(r, /\(hover:\s*hover\)/), `${r.selector} outside @media (hover: hover)`).toBe(true);
  });

  it("card hover lifts translateY between -2px and -4px", () => {
    const lifts = hoverRules.filter((r) => /translateY/.test(r.body));
    expect(lifts.length).toBeGreaterThan(0);
    for (const r of lifts) {
      const px = Number(/translateY\((-\d+)px\)/.exec(decl(r.body, "transform") ?? "")?.[1]);
      expect(px, r.selector).toBeGreaterThanOrEqual(-4);
      expect(px, r.selector).toBeLessThanOrEqual(-2);
    }
  });

  it("only transform and opacity are ever transitioned", () => {
    for (const r of rules) {
      const t = decl(r.body, "transition");
      const tp = decl(r.body, "transition-property");
      if (t && t !== "none") for (const part of t.split(/,(?![^(]*\))/)) expect(part.trim(), r.selector).toMatch(/^(transform|opacity)\b/);
      if (tp && tp !== "none") expect(tp, r.selector).toMatch(/^(transform|opacity)(\s*,\s*(transform|opacity))*$/);
    }
  });

  it("hover feedback is instant: transitions are 150ms or shorter", () => {
    for (const r of rules) {
      const t = decl(r.body, "transition");
      if (!t || t === "none") continue;
      for (const m of t.matchAll(/(\d+)ms/g)) expect(Number(m[1]), r.selector).toBeLessThanOrEqual(150);
      expect(t, r.selector).not.toMatch(/\d\.?\d*s\b(?<!ms)/);
    }
  });

  it("focus-visible gets a 2px electric ring with an offset", () => {
    const r = rules.find((x) => /:focus-visible/.test(x.selector) && /outline/.test(x.body) && x.ctx.length === 0);
    expect(r, "no focus-visible ring rule").toBeDefined();
    expect(decl(r!.body, "outline")).toMatch(/^2px solid var\(--lz-electric/);
    expect(decl(r!.body, "outline-offset")).toMatch(/^\d+px$/);
  });

  it("the existing 0.97 press rule in index.css is left alone", () => {
    expect(block).not.toMatch(/scale\(0\.97\)/);
    expect(rules.some((r) => /:active/.test(r.selector) && /scale/.test(r.body))).toBe(false);
  });
});

// ---- fallbacks ------------------------------------------------------------------------------------------------
describe("accessibility fallbacks for every blur and glow", () => {
  const blurSelectors = baseRules.filter((r) => /backdrop-filter/.test(r.body)).flatMap(selectorsOf);
  const glowSelectors = baseRules
    .filter((r) => /::after/.test(r.selector) && ELECTRIC.test(r.body))
    .flatMap(selectorsOf);

  it("finds blurs and glows to guard", () => {
    expect(blurSelectors.length).toBeGreaterThan(5);
    expect(glowSelectors.length).toBeGreaterThan(3);
  });

  it("prefers-reduced-transparency: reduce makes every blurred surface solid with no backdrop-filter", () => {
    const rs = rules.filter((r) => inCtx(r, /prefers-reduced-transparency:\s*reduce/));
    expect(rs.length).toBeGreaterThan(0);
    for (const sel of blurSelectors) {
      const r = rs.find((x) => selectorsOf(x).includes(sel));
      expect(r, `${sel} missing reduced-transparency fallback`).toBeDefined();
      expect(decl(r!.body, "backdrop-filter")).toBe("none");
      expect(decl(r!.body, "background")).toMatch(/var\(--lz-surface/);
    }
  });

  it("prefers-contrast: more gives every blurred surface a solid background and solid border", () => {
    const rs = rules.filter((r) => inCtx(r, /prefers-contrast:\s*more/));
    for (const sel of blurSelectors) {
      const r = rs.find((x) => selectorsOf(x).includes(sel));
      expect(r, `${sel} missing contrast fallback`).toBeDefined();
      expect(decl(r!.body, "backdrop-filter")).toBe("none");
      expect(r!.body).toMatch(/border-color\s*:/);
    }
  });

  it("prefers-contrast: more turns every glow into a solid ring", () => {
    const rs = rules.filter((r) => inCtx(r, /prefers-contrast:\s*more/));
    for (const sel of glowSelectors) {
      const r = rs.find((x) => selectorsOf(x).includes(sel));
      expect(r, `${sel} missing contrast glow fallback`).toBeDefined();
      expect(decl(r!.body, "box-shadow")).toMatch(/^0 0 0 2px /);
    }
  });

  it("prefers-reduced-motion: reduce removes lifts and glow transitions", () => {
    const rs = rules.filter((r) => inCtx(r, /prefers-reduced-motion:\s*reduce/));
    expect(rs.length).toBeGreaterThan(0);
    const lifted = hoverLifted();
    for (const sel of lifted) {
      const r = rs.find((x) => selectorsOf(x).includes(sel));
      expect(r, `${sel} missing reduced-motion override`).toBeDefined();
      expect(decl(r!.body, "transform")).toBe("none");
    }
    for (const sel of glowSelectors) {
      const r = rs.find((x) => selectorsOf(x).includes(sel));
      expect(r, `${sel} missing reduced-motion glow override`).toBeDefined();
      expect(decl(r!.body, "transition")).toBe("none");
    }
  });

  it("backdrop-filter has an opaque @supports not fallback", () => {
    const rs = rules.filter((r) => inCtx(r, /@supports not \(\(backdrop-filter:\s*blur\(1px\)\)/));
    expect(rs.length).toBeGreaterThan(0);
  });

  function hoverLifted(): string[] {
    return rules.filter((r) => /:hover/.test(r.selector) && /translateY/.test(r.body)).flatMap(selectorsOf).map((s) => s.replace(":hover", ""));
  }
});

// ---- gradient text --------------------------------------------------------------------------------------------
describe("metallic gradient text", () => {
  it("background-clip: text only appears inside @supports, and forced-colors restores solid text", () => {
    const clip = rules.filter((r) => /background-clip\s*:\s*text/.test(r.body));
    expect(clip.length).toBeGreaterThan(0);
    for (const r of clip) expect(inCtx(r, /@supports/), `${r.selector} clip outside @supports`).toBe(true);
    const forced = rules.filter((r) => inCtx(r, /forced-colors:\s*active/));
    expect(forced.length).toBeGreaterThan(0);
    for (const r of clip) {
      const f = forced.find((x) => selectorsOf(x).some((s) => selectorsOf(r).includes(s)));
      expect(f, `${r.selector} missing forced-colors fallback`).toBeDefined();
      expect(f!.body).toMatch(/-webkit-text-fill-color\s*:\s*currentcolor/i);
    }
  });

  it("the solid fallback colour is set before the @supports gradient", () => {
    for (const sel of [".landing-hero-headline", ".landing-bento-tile h3"]) {
      const base = baseRules.find((r) => selectorsOf(r).includes(sel) && /(^|[;\s])color:/.test(r.body));
      expect(base, `${sel} needs a solid color fallback`).toBeDefined();
    }
  });
});

// ---- tracking -------------------------------------------------------------------------------------------------
describe("size-specific tracking", () => {
  const em = (sel: string, ctx0 = true) =>
    Number(/(-?[\d.]+)em/.exec(decl(rules.find((r) => (ctx0 ? r.ctx.length === 0 : true) && selectorsOf(r).includes(sel) && /letter-spacing/.test(r.body))?.body ?? "", "letter-spacing") ?? "")?.[1]);
  it("larger display text is tighter than smaller headings; body copy stays near zero", () => {
    expect(em(".pricing-price")).toBeLessThan(0);
    expect(em(".landing-section h2")).toBeLessThan(0);
    expect(em(".landing-bento-tile h3")).toBeLessThanOrEqual(0);
    expect(em(".landing-bento-tile p")).toBeGreaterThanOrEqual(0);
    expect(em(".landing-bento-tile p")).toBeLessThanOrEqual(0.01);
    expect(em(".pricing-price")).toBeLessThan(em(".landing-bento-tile h3"));
  });
});

// ---- contrast -------------------------------------------------------------------------------------------------
function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const hexOf = (name: string) => {
  const v = resolve(tokens[name]);
  expect(v, `${name} must be a #rrggbb token`).toMatch(/^#[0-9a-f]{6}$/i);
  return v;
};

describe("WCAG contrast computed from the real tokens", () => {
  const surfaces = ["--lz-bg", "--lz-surface-top", "--lz-surface-bottom", "--lz-field-bg"];
  for (const text of ["--lz-text", "--lz-text-muted", "--lz-brand-text"]) {
    for (const s of surfaces) {
      it(`${text} on ${s} >= 4.5:1`, () => {
        expect(ratio(hexOf(text), hexOf(s))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  for (const stop of ["--lz-metal-from", "--lz-metal-to"]) {
    for (const s of ["--lz-hero", "--lz-surface-top", "--lz-surface-bottom"]) {
      it(`gradient stop ${stop} on ${s} >= 4.5:1`, () => {
        expect(ratio(hexOf(stop), hexOf(s))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it("form field border >= 3:1 against the card and the field", () => {
    expect(ratio(hexOf("--lz-field-border"), hexOf("--lz-surface-bottom"))).toBeGreaterThanOrEqual(3);
    expect(ratio(hexOf("--lz-field-border"), hexOf("--lz-field-bg"))).toBeGreaterThanOrEqual(3);
  });
  it("focus ring (electric bright) >= 3:1 against every surface", () => {
    for (const s of [...surfaces, "--lz-hero"]) expect(ratio(hexOf("--lz-electric-bright"), hexOf(s)), s).toBeGreaterThanOrEqual(3);
  });
});

// ---- density and scope ----------------------------------------------------------------------------------------
describe("density and scope", () => {
  const px = (sel: string, prop: string) => {
    const r = baseRules.find((x) => selectorsOf(x).includes(sel) && new RegExp(`(^|[;\\s])${prop}\\s*:`).test(x.body));
    return decl(r?.body ?? "", prop);
  };
  it("hero and section padding is tightened 15 to 25 percent from the original", () => {
    // originals: hero 40px 20px 56px, section 56px 20px
    const hero = px(".landing-hero", "padding")!.split(/\s+/).map((v) => parseFloat(v));
    expect(hero[0] / 40).toBeGreaterThanOrEqual(0.75);
    expect(hero[0] / 40).toBeLessThanOrEqual(0.85);
    expect(hero[2] / 56).toBeGreaterThanOrEqual(0.75);
    expect(hero[2] / 56).toBeLessThanOrEqual(0.85);
    const sec = px(".landing-section", "padding")!.split(/\s+/).map((v) => parseFloat(v));
    expect(sec[0] / 56).toBeGreaterThanOrEqual(0.75);
    expect(sec[0] / 56).toBeLessThanOrEqual(0.85);
  });
  it("every non-root selector in the block is landing-scoped (no dashboard or other-page selectors)", () => {
    for (const r of rules) for (const s of rawSelectors(r)) expect(s === ":root" || s.startsWith(SCOPE), `unscoped selector ${s}`).toBe(true);
    expect(block).not.toMatch(/\.dashboard|\.overview-|\.chart-stat|\.review-|\.auth-card/);
  });
});
