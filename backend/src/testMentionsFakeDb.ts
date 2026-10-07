// Test-only in-memory stand-in for the part of the supabase query builder that
// GET /mentions uses on scheduled_posts. Nothing here can reach a real database.
//
// It models the two behaviours the mentions fix depends on, so a test fails if the
// query is built wrongly:
//  1. A filter on an embedded table (social_accounts.platform) only removes POSTS
//     when the embed is declared "!inner". Without it the post stays and only its
//     embedded platform becomes null (this is how PostgREST behaves).
//  2. order and limit apply after every filter, whatever order the calls were made in.

export interface FakePost {
  id: string;
  account_id: string;
  status: string;
  scheduled_for: string;
  platform: string;
  verified: boolean;
  content?: string;
}

export interface FakeCall {
  op: string;
  args: unknown[];
}

export function makeMentionsFakeDb(posts: FakePost[], opts: { failWith?: string } = {}) {
  const calls: FakeCall[] = [];
  const from = (table: string) => {
    calls.push({ op: "from", args: [table] });
    let select = "";
    const filters: Array<(p: FakePost) => boolean> = [];
    const embedFilters: Array<(p: FakePost) => boolean> = [];
    let orderAsc = false;
    let limitN: number | null = null;
    const b: Record<string, unknown> = {};
    const rec = (op: string, args: unknown[]) => calls.push({ op, args });
    b.select = (s: string) => (rec("select", [s]), (select = s), b);
    b.eq = (c: string, v: unknown) => {
      rec("eq", [c, v]);
      if (c === "account_id") filters.push((p) => p.account_id === v);
      else if (c === "status") filters.push((p) => p.status === v);
      else if (c === "post_results.verified_live") filters.push((p) => p.verified === v);
      return b;
    };
    b.in = (c: string, v: string[]) => {
      rec("in", [c, v]);
      if (c === "social_accounts.platform") embedFilters.push((p) => v.includes(p.platform));
      return b;
    };
    b.not = (c: string, op: string, v: string) => {
      rec("not", [c, op, v]);
      if (c === "social_accounts.platform" && op === "in") {
        const list = v.replace(/^\(|\)$/g, "").split(",");
        embedFilters.push((p) => !list.includes(p.platform));
      }
      return b;
    };
    b.order = (_c: string, o?: { ascending?: boolean }) => (rec("order", [_c, o]), (orderAsc = o?.ascending === true), b);
    b.limit = (n: number) => (rec("limit", [n]), (limitN = n), b);
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      if (opts.failWith) return Promise.resolve({ data: null, error: { message: opts.failWith } }).then(resolve, reject);
      const inner = select.includes("social_accounts!inner");
      let rows = posts.filter((p) => filters.every((f) => f(p)));
      if (inner) rows = rows.filter((p) => embedFilters.every((f) => f(p)));
      rows = [...rows].sort((a, z) => (a.scheduled_for < z.scheduled_for ? -1 : 1) * (orderAsc ? 1 : -1));
      if (limitN !== null) rows = rows.slice(0, limitN);
      const data = rows.map((p) => ({
        id: p.id,
        content: p.content ?? `post ${p.id}`,
        scheduled_for: p.scheduled_for,
        social_account_id: `sa-${p.platform}`,
        // Without "!inner" a filter on the embed only blanks the embed.
        social_accounts: !inner && embedFilters.some((f) => !f(p)) ? null : { platform: p.platform },
        post_results: [{ platform_post_id: `pp-${p.id}`, platform_post_url: `https://example.com/${p.id}`, verified_live: p.verified }],
      }));
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    };
    return b;
  };
  return { db: { from } as never, calls };
}

// 20 Facebook posts newer than a handful of dev.to and Hashnode posts: the case
// the old query got wrong.
export function crowdedAccount(accountId = "acc1"): FakePost[] {
  const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString();
  const mk = (id: string, platform: string, n: number, extra: Partial<FakePost> = {}): FakePost => ({
    id, account_id: accountId, status: "posted", scheduled_for: day(n), platform, verified: true, ...extra,
  });
  return [
    ...Array.from({ length: 20 }, (_, i) => mk(`fb${i}`, "facebook", 10 + i)), // newest
    mk("dev1", "devto", 3),
    mk("dev2", "devto", 2),
    mk("hn1", "hashnode", 1),
  ];
}
