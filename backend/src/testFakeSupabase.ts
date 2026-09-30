// Test-only in-memory stand-in for the supabase query builder, shared by the
// scheduler and token tests. Nothing here can reach a real database.

export type Row = Record<string, unknown>;
export const tables: Record<string, Row[]> = {};
let idCounter = 0;

export function makeBuilder(table: string) {
  const rows = () => (tables[table] ??= []);
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "update" | "insert" = "select";
  let payload: Row | undefined;
  let returning = false;
  let selectCols = "";
  let orderCol: string | null = null;
  let orderAsc = true;
  let limitN: number | null = null;
  let singleMode: "none" | "single" | "maybe" = "none";

  const b: Record<string, unknown> = {};
  b.select = (cols?: string) => {
    selectCols = cols ?? "";
    if (mode !== "select") returning = true;
    return b;
  };
  b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
  b.neq = (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b);
  b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
  b.in = (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b);
  b.lt = (c: string, v: string) => (filters.push((r) => String(r[c]) < v), b);
  b.lte = (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), b);
  b.gt = (c: string, v: string) => (filters.push((r) => String(r[c]) > v), b);
  b.not = (c: string, _op: string, v: unknown) => (filters.push((r) => (r[c] ?? null) !== v), b);
  b.order = (c: string, o?: { ascending?: boolean }) => ((orderCol = c), (orderAsc = o?.ascending !== false), b);
  b.limit = (n: number) => ((limitN = n), b);
  b.single = () => ((singleMode = "single"), b);
  b.maybeSingle = () => ((singleMode = "maybe"), b);
  b.update = (p: Row) => ((mode = "update"), (payload = p), b);
  b.insert = (p: Row) => ((mode = "insert"), (payload = p), b);
  b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    let out: Row[];
    if (mode === "insert") {
      const row = { id: `id${++idCounter}`, created_at: new Date(Date.now() + idCounter).toISOString(), ...payload };
      rows().push(row);
      out = [row];
    } else {
      out = rows().filter((r) => filters.every((f) => f(r)));
      if (mode === "update") out.forEach((r) => Object.assign(r, payload));
    }
    if (orderCol) out = [...out].sort((a, z) => (String(a[orderCol!]) < String(z[orderCol!]) ? -1 : 1) * (orderAsc ? 1 : -1));
    if (limitN !== null) out = out.slice(0, limitN);
    if (selectCols.includes("social_accounts(platform)")) {
      out = out.map((r) => ({ ...r, social_accounts: { platform: (tables.social_accounts ?? []).find((s) => s.id === r.social_account_id)?.platform } }));
    }
    const wantsRows = mode === "select" || returning;
    const data = !wantsRows ? null : singleMode === "none" ? out : (out[0] ?? null);
    const error = singleMode === "single" && wantsRows && out.length === 0 ? { message: "no rows" } : null;
    return Promise.resolve({ data, error }).then(resolve, reject);
  };
  return b;
}

