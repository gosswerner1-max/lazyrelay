import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import llms from "../../public/llms.txt?raw";
import platformFeatures from "../../public/platform-features/index.html?raw";
import about from "../../public/about/index.html?raw";
import developers from "../../public/developers/index.html?raw";
import indexHtml from "../../index.html?raw";
import { HOME_FAQ } from "./homeFaq";

// One public wording for the platform count (Werner, 2026-10-16): the platform picker lists 18 distribution platforms
// (the original 17 plus X, connected with the customer's own X developer keys) and WhatsApp, which is client messaging
// connected with the customer's own Meta WhatsApp Business credentials. Nothing public may still say "17 platforms",
// and no page may say X is unsupported or coming soon.
const PHRASE = "18 distribution platforms plus WhatsApp";
const root = resolve(__dirname, "..", "..", "..");

const OLD_COUNT = /\b17 (platforms|social platforms|supported social platforms|networks|distribution)|\b(?:of|all|same|the) 17\b|\b17: Facebook|<b>17<\/b>|\bseventeen\b|The 17 platforms/i;
const OLD_X = /X is coming soon|LazyRelay does not currently support X|LazyRelay does not offer X|X \(Twitter\)<\/td><td>Not supported|<td>Not supported \(X|which LazyRelay doesn't (yet )?\(?X|posts to X, which LazyRelay doesn't support|doesn't need X \(Twitter\)|You need X \(Twitter\)/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", "coverage"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(html|txt|md|ts|tsx|mjs|json)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !/package(-lock)?\.json$/.test(name)) out.push(p);
  }
  return out;
}

describe("platform count wording", () => {
  const files = [
    ...walk(join(root, "frontend", "public")),
    ...walk(join(root, "frontend", "src")),
    ...walk(join(root, "frontend", "scripts")),
    join(root, "frontend", "index.html"),
    join(root, "README.md"),
  ];

  it("no public page, source file, script or README still says 17 platforms", () => {
    const hits = files.filter((f) => OLD_COUNT.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1));
    expect(hits).toEqual([]);
  });

  it("no public page says X is unsupported or coming soon", () => {
    const hits = files
      .filter((f) => f.includes(`${join("frontend", "public")}`) || f.endsWith("Landing.tsx"))
      .filter((f) => OLD_X.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1));
    expect(hits).toEqual([]);
  });

  it("the exact phrase is on the home FAQ, llms.txt, platform-features, about, developers and the home meta tags", () => {
    expect(HOME_FAQ.map((f) => f.a).join("\n")).toContain(PHRASE);
    for (const [name, text] of Object.entries({ llms, platformFeatures, about, developers, indexHtml })) {
      expect(text, name).toContain(PHRASE);
    }
  });

  it("platform-features lists X and WhatsApp, and says X needs the customer's own developer keys", () => {
    expect(platformFeatures).toContain("<tr><td>X</td>");
    expect(platformFeatures).toMatch(/WhatsApp/);
    expect(platformFeatures).toMatch(/own X developer keys/);
  });

  it("no em or en dashes were added to the home FAQ", () => {
    expect(HOME_FAQ.map((f) => f.a).join("")).not.toMatch(/[–—]/);
  });
});
