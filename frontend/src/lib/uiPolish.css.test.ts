/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Vitest hands back an empty string for plain .css?raw imports, so read the files directly.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const indexCss = read("../index.css");
const appCss = read("../App.css");
const dashboardCss = read("../pages/Dashboard.css");
const reviewCss = read("../pages/ReviewPage.css");

// UI polish guard (2026-10-14, Werner's Apple-design repairs): press feedback on pointer-down, hover lifts only on
// hover-capable devices, unitless heading leading, reduced-motion fallback. These read the real stylesheets, so a
// regression in the CSS fails here.

interface Node {
  selector: string;
  body: string;
  children: Node[];
}

function parse(css: string): Node[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  function block(): Node[] {
    const nodes: Node[] = [];
    while (i < src.length) {
      const start = i;
      while (i < src.length && src[i] !== "{" && src[i] !== "}" && src[i] !== ";") i++;
      if (i >= src.length || src[i] === "}") return nodes;
      if (src[i] === ";") {
        i++;
        continue; // @import etc.
      }
      const selector = src.slice(start, i).trim().replace(/\s+/g, " ");
      i++; // {
      const isAt = selector.startsWith("@");
      if (isAt && !/^@(media|supports)/.test(selector)) {
        // @keyframes / @font-face: skip the whole block
        let depth = 1;
        while (i < src.length && depth > 0) {
          if (src[i] === "{") depth++;
          if (src[i] === "}") depth--;
          i++;
        }
        continue;
      }
      if (isAt) {
        const children = block();
        i++; // }
        nodes.push({ selector, body: "", children });
      } else {
        const bodyStart = i;
        while (i < src.length && src[i] !== "}") i++;
        nodes.push({ selector, body: src.slice(bodyStart, i), children: [] });
        i++; // }
      }
    }
    return nodes;
  }
  return block();
}

const index = parse(indexCss);
const app = parse(appCss);
const dashboard = parse(dashboardCss);

function flat(nodes: Node[], ctx: string[] = []): Array<{ selector: string; body: string; ctx: string[] }> {
  return nodes.flatMap((n) =>
    n.selector.startsWith("@") ? flat(n.children, [...ctx, n.selector]) : [{ selector: n.selector, body: n.body, ctx }],
  );
}

const allRules = [...flat(index), ...flat(app), ...flat(dashboard), ...flat(parse(reviewCss))];
const decl = (body: string, prop: string) => body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`))?.[1].trim();

const PRESS_TARGETS = [".cta", ".landing-nav-links a", ".mobile-nav-menu a", ".tab-more-menu a"];

function pressRule(reduced: boolean) {
  return allRules.find(
    (r) =>
      r.selector.includes(":active") &&
      r.selector.split(",").some((s) => /\bbutton\b/.test(s)) &&
      PRESS_TARGETS.every((t) => r.selector.includes(t)) &&
      r.ctx.some((c) => c.includes("prefers-reduced-motion")) === reduced,
  );
}

describe("press feedback (pointer-down)", () => {
  it("a shared :active rule scales button, .cta and the nav links to 0.97 with a 100ms ease-out", () => {
    const rule = pressRule(false);
    expect(rule, "no shared :active rule covering button + .cta + nav links").toBeDefined();
    expect(decl(rule!.body, "transform")).toBe("scale(0.97)");
    expect(decl(rule!.body, "transition")).toBe("transform 100ms ease-out");
  });

  it("the same controls opt out of the tap delay with touch-action: manipulation", () => {
    const rule = allRules.find(
      (r) =>
        !r.selector.includes(":active") &&
        r.selector.split(",").some((s) => /^(:where\()?\s*button\b/.test(s.trim())) &&
        PRESS_TARGETS.every((t) => r.selector.includes(t)),
    );
    expect(rule, "no shared touch-action rule").toBeDefined();
    expect(decl(rule!.body, "touch-action")).toBe("manipulation");
  });

  it("prefers-reduced-motion removes the scale for that rule", () => {
    const rule = pressRule(true);
    expect(rule, "no reduced-motion override for the press rule").toBeDefined();
    expect(decl(rule!.body, "transform")).toBe("none");
  });
});

describe("hover lifts only on hover-capable devices", () => {
  const lifts = (rules: ReturnType<typeof flat>) =>
    rules.filter((r) => r.selector.endsWith(":hover") && /transform:\s*translate/.test(r.body));

  it("finds the two hover-lift rules", () => {
    // the original bento lift plus the landing overhaul's own (landingOverhaul.css.test.ts guards those in detail)
    expect(lifts(flat(app)).map((r) => r.selector)).toContain(".landing-bento-tile:hover");
    expect(lifts(flat(dashboard)).map((r) => r.selector)).toEqual([".overview-panel .chart-stat-tile:hover"]);
  });

  it("every hover-lift rule sits inside @media (hover: hover)", () => {
    const all = [...lifts(flat(app)), ...lifts(flat(dashboard))];
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const r of all) {
      expect(r.ctx.some((c) => /\(hover:\s*hover\)/.test(c)), `${r.selector} is not inside @media (hover: hover)`).toBe(true);
    }
  });
});

describe("typography leading", () => {
  const root = index.find((n) => n.selector === ":root")!;

  it("the root font shorthand uses a unitless line-height (a percentage inherits as a fixed px value)", () => {
    const font = decl(root.body, "font")!;
    expect(font).toMatch(/16px\/1\.5\b/);
    expect(font).not.toMatch(/%/);
  });

  it("h1/h2 get an explicit tighter unitless leading between 1.1 and 1.2", () => {
    const rule = index.find((n) => n.selector === "h1, h2")!;
    const lh = Number(decl(rule.body, "line-height"));
    expect(lh).toBeGreaterThanOrEqual(1.1);
    expect(lh).toBeLessThanOrEqual(1.2);
  });

  it(".chart-stat-value and .pricing-price (not heading tags) get the same tight unitless leading", () => {
    for (const sel of [".chart-stat-value", ".pricing-price"]) {
      const rule = allRules.find((r) => r.selector === sel && !r.ctx.length)!;
      const lh = Number(decl(rule.body, "line-height"));
      expect(lh, `${sel} line-height`).toBeGreaterThanOrEqual(1.1);
      expect(lh, `${sel} line-height`).toBeLessThanOrEqual(1.2);
    }
  });

  it("heading selectors never reintroduce a px or % line-height", () => {
    const headings = [".landing-section h2", ".auth-card h1", ".legal-page h1", ".review-inner h1", ".modal-header h2"];
    for (const sel of headings) {
      const rule = allRules.find((r) => r.selector === sel);
      expect(rule, sel).toBeDefined();
      const lh = decl(rule!.body, "line-height");
      if (lh) expect(lh, `${sel} line-height`).toMatch(/^\d*\.?\d+$/);
    }
  });

  it("leaves letter-spacing and font sizes alone", () => {
    const rule = index.find((n) => n.selector === "h1, h2")!;
    expect(decl(rule.body, "letter-spacing")).toBe("-0.01em");
    expect(decl(allRules.find((r) => r.selector === ".landing-section h2")!.body, "font-size")).toBe("26px");
    expect(decl(allRules.find((r) => r.selector === ".pricing-price")!.body, "font-size")).toBe("34px");
    expect(decl(allRules.find((r) => r.selector === ".chart-stat-value")!.body, "font-size")).toBe("28px");
  });
});
