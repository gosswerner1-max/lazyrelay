// Guard for migration 0134: the signed-in browser role (`authenticated`) keeps UPDATE only on the columns the dashboard routes
// really write. requireAuth gives dashboard routes req.db, a client running AS that role, so any write to public.social_accounts
// through req.db must stay inside the granted column list. Every other writer must use the service-role client (`supabase`).
// This reads the source as text (the repo has no SQL harness). Limits: it sees `req.db` / `.db!` chains only, not a db handle
// passed into a helper or aliased to another name. When this fails, either use the service-role client or extend the grant.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../supabase/migrations");
const migration = fs.readFileSync(path.join(migrationsDir, fs.readdirSync(migrationsDir).find((f) => f.startsWith("0134_"))!), "utf8");
const migrationCode = migration.replace(/^\s*--.*$/gm, "");
const grantMatch = migrationCode.match(/grant\s+update\s*\(([^)]*)\)\s+on\s+public\.social_accounts\s+to\s+authenticated/i);
const GRANTED = grantMatch ? grantMatch[1].split(",").map((c) => c.trim()).filter(Boolean) : [];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

/** Top-level keys of the object literal that starts at `open` (the index of "{"). Null when the argument is not a literal. */
function objectKeys(text: string, open: number): string[] | null {
  const keys: string[] = [];
  let depth = 0;
  let i = open;
  let segStart = open + 1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) {
      depth--;
      if (depth === 0) break;
    } else if (ch === "," && depth === 1) {
      pushKey(text.slice(segStart, i), keys);
      segStart = i + 1;
    }
  }
  pushKey(text.slice(segStart, i), keys);
  return keys;
}
function pushKey(seg: string, keys: string[]) {
  const m = seg.trim().match(/^["']?(\w+)["']?\s*(:|$)/);
  if (m) keys.push(m[1]);
  else if (seg.trim()) keys.push(`<<unparsed: ${seg.trim().slice(0, 40)}>>`);
}

type Write = { where: string; problem: string | null; columns: string[] };

function userClientWrites(): Write[] {
  const out: Write[] = [];
  for (const file of sourceFiles(path.join(here))) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(here, file).split(path.sep).join("/");
    const re = /\.from\(\s*["']social_accounts["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      if (!/(req\.db|\.db)!?\s*$/.test(before)) continue; // service-role `supabase` and others are out of scope
      const rest = text.slice(m.index + m[0].length);
      const end = rest.search(/;|\bawait\b|\breq\.db\b/);
      const chain = end === -1 ? rest : rest.slice(0, end);
      const line = text.slice(0, m.index).split("\n").length;
      const where = `${rel}:${line}`;
      for (const w of chain.matchAll(/\.(insert|upsert|delete|update)\s*\(\s*(\{)?/g)) {
        if (w[1] !== "update") {
          out.push({ where, problem: `${w[1]}() through req.db on social_accounts (the 0134 grant allows UPDATE of selected columns only)`, columns: [] });
          continue;
        }
        const open = w[2] ? rest.indexOf("{", w.index) : -1;
        const keys = open === -1 ? null : objectKeys(rest, open);
        out.push(
          keys ? { where, problem: null, columns: keys } : { where, problem: "update() argument is not an object literal, so its columns cannot be checked", columns: [] },
        );
      }
    }
  }
  return out;
}

describe("user-scoped client writes to public.social_accounts stay inside the 0134 column grant", () => {
  it("the migration grants exactly brand_id, brand_label, disconnected_at to authenticated", () => {
    expect([...GRANTED].sort()).toEqual(["brand_id", "brand_label", "disconnected_at"]);
  });

  const writes = userClientWrites();

  it("finds the four known dashboard writes (so this scan cannot silently go blind)", () => {
    expect(writes.map((w) => w.where.split(":")[0]).sort()).toEqual([
      "http/routes/brands.routes.ts",
      "http/routes/brands.routes.ts",
      "http/routes/socialAccounts.routes.ts",
      "http/routes/socialAccounts.routes.ts",
    ]);
  });

  it("every req.db write is an UPDATE whose columns are all granted", () => {
    const bad = writes.flatMap((w) => {
      if (w.problem) return [`${w.where}: ${w.problem}`];
      const outside = w.columns.filter((c) => !GRANTED.includes(c));
      return outside.length ? [`${w.where}: writes ${outside.join(", ")} through req.db, not granted to authenticated by migration 0134`] : [];
    });
    expect(bad, `\n${bad.join("\n")}\n`).toEqual([]);
  });
});
