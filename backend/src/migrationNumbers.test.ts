import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Supabase CLI and branches keep only one file per version number, so two migrations that
// share a number leave a database built fresh from the repo silently missing one of them. This
// happened twice (0007 and 0023, renumbered to 0120 and 0121 on 2026-10-10). Fail loudly instead.
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

describe("supabase migrations", () => {
  it("every file name starts with a four-digit number", () => {
    const bad = files.filter((f) => !/^\d{4}_/.test(f));
    expect(bad).toEqual([]);
  });

  it("no two files share a numeric prefix", () => {
    const byNumber = new Map<string, string[]>();
    for (const f of files) {
      const n = f.slice(0, 4);
      byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
    }
    const dupes = [...byNumber.entries()].filter(([, names]) => names.length > 1);
    expect(dupes).toEqual([]);
  });
});
