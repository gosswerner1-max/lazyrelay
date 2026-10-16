// Postgres rejects a regular-expression repetition count above 255 ("invalid repetition count(s)") the first time a row is checked
// against it, not when the table is created. Found 2026-10-16 on a throwaway Supabase branch: three WhatsApp CHECK constraints used
// {1,512} for template names, so every template, broadcast and chat insert with a template name would have failed in production.
// This guard reads the SQL of the WhatsApp migrations (0124 and later) and fails on any repetition count above 255 inside a regex.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "../supabase/migrations");
const PG_REGEX_MAX_REPEAT = 255;

const files = fs
  .readdirSync(dir)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= 124)
  .sort();

describe("migrations 0124 and later: regular-expression repetition counts stay within Postgres's limit", () => {
  it("finds the migrations to scan", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each(files)("%s has no regex repetition above 255", (file) => {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const tooBig: string[] = [];
    for (const line of sql.split(/\r?\n/)) {
      if (/^\s*--/.test(line)) continue;
      for (const m of line.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
        const max = Number(m[2] !== undefined && m[2] !== "" ? m[2] : m[1]);
        if (max > PG_REGEX_MAX_REPEAT) tooBig.push(`${m[0]} in: ${line.trim().slice(0, 100)}`);
      }
    }
    expect(tooBig, file).toEqual([]);
  });
});
