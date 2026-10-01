// Test-only: an in-memory stand-in for Whop's API (the endpoints LazyRelay uses), driven through a stubbed fetch.
// Nothing here can reach the network. It enforces what the real API enforces for the cases the tests care about:
// the bearer credential, the app being installed in the community, cursor paging, and idempotent replays.

export const APP_PASS = "pass-for-tests-only";
export const APP_ID = "app_TestApp1234";

export interface FakePost {
  id: string;
  title: string | null;
  content: string | null;
  parent_id: string | null;
  is_poster_admin: boolean;
  created_at: string;
  user: { id: string; username: string; name: string };
}

export interface FakeCompany {
  id: string;
  title: string;
  route: string;
  installed: boolean;
  experiences: Array<{ id: string; name: string; appName: string }>;
}

export interface Scripted {
  match: (method: string, path: string) => boolean;
  status: number;
  body?: unknown;
  /** Throw a network error instead of answering. */
  networkError?: boolean;
  /** Do the work (create the post) first, then lose the answer. */
  afterEffect?: boolean;
  times?: number;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  url: string;
}

export function createFakeWhop(companies: FakeCompany[]) {
  const byId = new Map(companies.map((c) => [c.id, c]));
  const posts = new Map<string, FakePost[]>(); // forum id -> newest first
  const calls: RecordedCall[] = [];
  const scripted: Scripted[] = [];
  const idem = new Map<string, { bodyText: string; status: number; body: unknown }>();
  let counter = 0;
  const opts = { rewriteContent: (s: string) => s, pageSize: 20 };

  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  function addPost(forumId: string, content: string, o: { admin: boolean; parent?: string | null; createdAt?: string; user?: string }): FakePost {
    const post: FakePost = {
      id: `post_Test${String(++counter).padStart(6, "0")}`,
      title: null,
      content,
      parent_id: o.parent ?? null,
      is_poster_admin: o.admin,
      created_at: o.createdAt ?? new Date().toISOString(),
      user: { id: `user_${o.user ?? "someone"}`, username: o.user ?? "someone", name: o.user ?? "Someone" },
    };
    posts.set(forumId, [post, ...(posts.get(forumId) ?? [])]);
    return post;
  }

  function forumExists(id: string): FakeCompany | undefined {
    return companies.find((c) => c.installed && c.experiences.some((e) => e.id === id));
  }

  function paged<T>(items: T[], query: URLSearchParams) {
    const size = Math.min(Number(query.get("first") ?? opts.pageSize), opts.pageSize);
    const start = Number(query.get("after") ?? 0) || 0;
    const slice = items.slice(start, start + size);
    const next = start + size;
    return { data: slice, page_info: { has_next_page: next < items.length, end_cursor: next < items.length ? String(next) : null, has_previous_page: start > 0, start_cursor: String(start) } };
  }

  async function handler(input: unknown, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    if (url.protocol !== "https:" || url.host !== "api.whop.com") throw new Error(`unexpected host ${url.host}`);
    const method = init.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, path, query: url.searchParams, headers, body, url: url.toString() });

    const hit = scripted.find((s) => (s.times ?? 1) > 0 && s.match(method, path));
    if (hit && !hit.afterEffect) {
      hit.times = (hit.times ?? 1) - 1;
      if (hit.networkError) throw new Error("socket hang up");
      return reply(hit.status, hit.body ?? {}, hit.status === 429 ? {} : {});
    }

    if (headers.authorization !== `Bearer ${APP_PASS}`) return reply(401, { error: { code: "unauthorized", message: "Invalid API key" } });

    if (method === "GET" && path === "/experiences") {
      const company = byId.get(url.searchParams.get("company_id") ?? "");
      if (!company) return reply(404, { error: { code: "not_found", message: "Company not found" } });
      if (!company.installed) return reply(403, { error: { code: "forbidden", message: "App is not installed" } });
      const items = company.experiences.map((e) => ({
        id: e.id, name: e.name, is_public: true, order: "1", created_at: "2026-10-01T10:00:00Z",
        app: { id: "app_x", name: e.appName, icon: null }, image: null, company: { id: company.id, title: company.title, route: company.route },
      }));
      return reply(200, paged(items, url.searchParams));
    }

    if (method === "GET" && path === "/forum_posts") {
      const forum = url.searchParams.get("experience_id") ?? "";
      if (!forumExists(forum)) return reply(404, { error: { code: "not_found", message: "Experience not found" } });
      return reply(200, paged(posts.get(forum) ?? [], url.searchParams));
    }

    if (method === "POST" && path === "/forum_posts") {
      const forum = String(body?.experience_id ?? "");
      const key = headers["idempotency-key"];
      const bodyText = JSON.stringify(body);
      if (key) {
        const seen = idem.get(key);
        if (seen) {
          if (seen.bodyText !== bodyText) return reply(400, { error: { code: "invalid_request", message: "Idempotency key reused with a different request" } });
          return reply(seen.status, seen.body, { "idempotent-replayed": "true" });
        }
      }
      if (!forumExists(forum)) return reply(404, { error: { code: "not_found", message: "Experience not found" } });
      const post = addPost(forum, opts.rewriteContent(String(body?.content ?? "")), { admin: true, user: "lazyrelay" });
      if (key) idem.set(key, { bodyText, status: 200, body: post });
      if (hit && hit.afterEffect) {
        hit.times = (hit.times ?? 1) - 1;
        throw new Error("socket hang up");
      }
      return reply(200, post);
    }

    const one = /^\/forum_posts\/(post_[A-Za-z0-9]+)$/.exec(path);
    if (method === "GET" && one) {
      for (const list of posts.values()) {
        const found = list.find((p) => p.id === one[1]);
        if (found) return reply(200, found);
      }
      return reply(404, { error: { code: "not_found", message: "Post not found" } });
    }
    return reply(404, { error: { code: "not_found", message: "no such endpoint" } });
  }

  return {
    handler,
    calls,
    scripted,
    posts,
    opts,
    addPost,
    callsTo: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
    setInstalled: (companyId: string, installed: boolean) => {
      const c = byId.get(companyId);
      if (c) c.installed = installed;
    },
  };
}

export const COMPANY: FakeCompany = {
  id: "biz_TestCo12345",
  title: "Lazyrelay",
  route: "lazyrelay-test",
  installed: true,
  experiences: [
    { id: "exp_ForumOne1234", name: "Forums", appName: "Forums" },
    { id: "exp_ChatRoom1234", name: "Chat", appName: "Chat" },
    { id: "exp_ForumTwo1234", name: "Public forum", appName: "Forums" },
  ],
};

export const freshCompany = (): FakeCompany => ({ ...COMPANY, experiences: COMPANY.experiences.map((e) => ({ ...e })) });
