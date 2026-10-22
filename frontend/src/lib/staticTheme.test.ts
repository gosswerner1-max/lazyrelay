// Every static public page carries the Midnight Canvas theme: either the shared site stylesheet (the rebuilt pages) or the theme layer (the older pages).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const PUBLIC = join(__dirname, "..", "..", "public");
const pages = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "assets-static" || name === "home-icons" || name === "icons") return [];
    if (statSync(p).isDirectory()) return pages(p);
    return name === "index.html" ? [p] : [];
  });

describe("static pages use the new theme", () => {
  const files = pages(PUBLIC).filter((f) => /<style|circuit-bg\.css|lr-site\.css/.test(readFileSync(f, "utf8")));
  it("finds the static pages", () => expect(files.length).toBeGreaterThan(40));
  it("links lr-theme.css or lr-site.css on every one, and the theme file ships its fonts", () => {
    const missing = files.filter((f) => !/lr-theme\.css|lr-site\.css/.test(readFileSync(f, "utf8")));
    expect(missing).toEqual([]);
    expect(existsSync(join(PUBLIC, "assets-static", "fonts", "league-spartan-700.woff2"))).toBe(true);
  });
  it("the theme layer never uses a purple or violet hue word", () => {
    expect(readFileSync(join(PUBLIC, "assets-static", "lr-theme.css"), "utf8")).not.toMatch(/purple|violet/i);
  });
});
