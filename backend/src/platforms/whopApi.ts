// The only place LazyRelay talks to Whop's API (checked against docs.whop.com on 2026-10-01, the pages are listed in
// whop.ts). Everything here is deliberately narrow:
//   - ONE fixed host (api.whop.com), https only, redirects refused, a timeout on every call, response size capped.
//   - ONE credential for every community: the LazyRelay Whop app's own API key, read from the environment and held in
//     a true private field. It is only ever sent in the Authorization header. It is never returned, logged, stored
//     per customer, or put into an error: every message that leaves this file is built from fixed words, validated
//     ids and a number, and Whop's own error text is scrubbed (and the key redacted from it) first.
//   - Every id that ends up in a URL path is checked against a strict pattern first, so nothing can inject a path.

export const WHOP_API_BASE = "https://api.whop.com/api/v1";
/** The dated API version the endpoints used here were checked against (docs.whop.com create-forum-post shows
 *  2026-09-29). Sent on every call so a later Whop release cannot silently change a response shape under us. */
export const WHOP_API_VERSION_DATE = "2026-09-29";
/** Whop states no limit for a forum post. 4,000 characters is LazyRelay's own conservative number. */
export const WHOP_TEXT_LIMIT = 4000;

const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 1_000_000;
const PAGE_SIZE = 20;
const MAX_PAGES = 10;
const MAX_EXPERIENCES = 200;

// Whop ids are a prefix plus letters and digits. Some contain look-alike letters (a capital I next to a lowercase l),
// so ids always come from the API and are never retyped; these patterns only keep a path from being injected.
export const COMPANY_ID = /^biz_[A-Za-z0-9]{4,40}$/;
export const EXPERIENCE_ID = /^exp_[A-Za-z0-9]{4,40}$/;
export const POST_ID = /^post_[A-Za-z0-9]{4,40}$/;
export const APP_ID = /^app_[A-Za-z0-9]{4,40}$/;
// A community's route is the short name in its public address (whop.com/<route>/).
const COMPANY_ROUTE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface WhopReply {
  status: number;
  json: Record<string, unknown>;
  /** Seconds Whop asked us to wait (429 body "Try again in 12 seconds.", or a Retry-After header), else null. */
  retryAfterSeconds: number | null;
  /** Whop's own message, scrubbed and shortened. Never contains the app key. */
  message: string;
}

export interface WhopForum {
  id: string;
  /** Picker text such as "Forums (Lazyrelay)". */
  label: string;
}

export interface WhopForumList {
  companyId: string;
  companyTitle: string;
  companyRoute: string | null;
  forums: WhopForum[];
  /** Every experience of the community, by id, with its route (used to build proof links). */
  routeByExperience: Map<string, string | null>;
}

/** Only letters, digits, spaces and a few quiet characters survive: these names reach the picker, the account label
 *  and ops alerts, so Whop-supplied text is never trusted as markup. */
export function safeLabel(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[^\p{L}\p{N}\p{M} _.'&()-]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** "Try again in 12 seconds." -> 12. Capped at an hour so a hostile or broken answer cannot park a post for days. */
export function parseRateLimitDelay(message: string | null | undefined, headerValue?: string | null): number | null {
  const fromBody = /(\d{1,6})\s*(?:second|sec)/i.exec(message ?? "");
  const fromHeader = /^\d{1,6}$/.test((headerValue ?? "").trim()) ? Number.parseInt((headerValue ?? "").trim(), 10) : null;
  const seconds = fromBody ? Number.parseInt(fromBody[1], 10) : fromHeader;
  return seconds !== null && seconds > 0 ? Math.min(seconds, 3600) : null;
}

/** Whop's "forum" apps are named "Forums" (the community's public forum can also show as "Public forum"). Matching the
 *  app name keeps chat rooms, courses and other experiences out of the picker. */
export function isForumApp(appName: unknown): boolean {
  return typeof appName === "string" && /^(public )?forums?$/i.test(appName.trim());
}

export function routeLooksSafe(route: unknown): route is string {
  return typeof route === "string" && COMPANY_ROUTE.test(route);
}

/** The public link to one forum post (confirmed in the browser 2026-10-01). Null unless every part is well formed. */
export function whopPostUrl(route: string | null, experienceId: string, postId: string): string | null {
  if (!route || !routeLooksSafe(route) || !EXPERIENCE_ID.test(experienceId) || !POST_ID.test(postId)) return null;
  return `https://whop.com/${route}/${experienceId}/app/posts/${postId}/`;
}

export class WhopClient {
  readonly #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  // The key must never appear in anything we hand out. This keeps it out of JSON.stringify(adapter), util.inspect
  // output and structured logs even if an object holding this client is logged by mistake.
  toJSON(): string {
    return "[WhopClient]";
  }

  #scrub(text: string): string {
    let out = text;
    if (this.#apiKey) out = out.split(this.#apiKey).join("[removed]");
    // Control characters and anything that looks like a bearer secret never leave this file.
    return out.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\b(?:apik|sk|ws|whop)_[A-Za-z0-9_-]{16,}\b/g, "[removed]").replace(/\s+/g, " ").trim().slice(0, 300);
  }

  /** One call. `path` is built by this file's own methods from fixed words and validated ids. Throws on a network
   *  failure or timeout (callers word that as "could not reach Whop"). */
  async request(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; json?: unknown; idempotencyKey?: string } = {},
  ): Promise<WhopReply> {
    if (!/^\/[a-z_]+(\/(?:post|exp|biz)_[A-Za-z0-9]+)?$/.test(path)) throw new Error("internal: bad Whop path");
    const url = new URL(`${WHOP_API_BASE}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      "Api-Version-Date": WHOP_API_VERSION_DATE,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const res = await fetch(url.toString(), { method, headers, body, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });

    let text = "";
    const declared = Number.parseInt(res.headers?.get?.("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      text = "";
    } else if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          chunks.length = 0;
          break;
        }
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString("utf8");
    } else {
      text = (await res.text().catch(() => "")).slice(0, MAX_BODY_BYTES);
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      // Not JSON (a gateway page, for example): the status code carries the story.
    }
    const err = json.error as { message?: unknown } | string | undefined;
    const rawMessage = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : "";
    const message = this.#scrub(rawMessage);
    return { status: res.status, json, message, retryAfterSeconds: res.status === 429 ? parseRateLimitDelay(message, res.headers?.get?.("retry-after")) : null };
  }

  /** Every experience of one community, paged and capped. Throws WhopApiError on a refusal. */
  async listExperiences(companyId: string): Promise<Array<Record<string, unknown>>> {
    if (!COMPANY_ID.test(companyId)) throw new WhopApiError("whop_bad_request", 400, "That is not a Whop community id.");
    const items: Array<Record<string, unknown>> = [];
    let after = "";
    for (let page = 0; page < MAX_PAGES && items.length < MAX_EXPERIENCES; page++) {
      const query: Record<string, string> = { company_id: companyId, first: String(PAGE_SIZE) };
      if (after) query.after = after;
      let reply: WhopReply;
      try {
        reply = await this.request("GET", "/experiences", { query });
      } catch {
        throw new WhopApiError("whop_unreachable", 0, "Could not reach Whop.");
      }
      if (reply.status < 200 || reply.status >= 300) throw errorFromReply(reply);
      const data = Array.isArray(reply.json.data) ? (reply.json.data as unknown[]) : [];
      for (const item of data) if (item && typeof item === "object") items.push(item as Record<string, unknown>);
      const info = reply.json.page_info as { has_next_page?: unknown; end_cursor?: unknown } | undefined;
      after = info?.has_next_page === true && typeof info.end_cursor === "string" && info.end_cursor.length <= 300 ? info.end_cursor : "";
      if (!after) break;
    }
    return items.slice(0, MAX_EXPERIENCES);
  }

  /** The forums of one community (the app must be installed there, or Whop answers 401/403/404). */
  async listForums(companyId: string): Promise<WhopForumList> {
    const items = await this.listExperiences(companyId);
    const forums: WhopForum[] = [];
    const routeByExperience = new Map<string, string | null>();
    let companyTitle = "";
    let companyRoute: string | null = null;
    for (const item of items) {
      const company = item.company as { id?: unknown; title?: unknown; route?: unknown } | undefined;
      // A community's list must only ever contain that community's own experiences.
      if (typeof item.id !== "string" || !EXPERIENCE_ID.test(item.id) || company?.id !== companyId) continue;
      const route = routeLooksSafe(company.route) ? company.route : null;
      routeByExperience.set(item.id, route);
      if (!companyTitle) companyTitle = safeLabel(company.title, 80);
      if (!companyRoute && route) companyRoute = route;
      const app = item.app as { name?: unknown } | undefined;
      if (!isForumApp(app?.name)) continue;
      const name = safeLabel(item.name, 60) || "Forums";
      forums.push({ id: item.id, label: `${name} (${companyTitle || "Whop community"})` });
    }
    return { companyId, companyTitle: companyTitle || "Whop community", companyRoute, forums, routeByExperience };
  }
}

/** A refusal or failure from Whop, already reduced to a short code plus words that are safe to show. */
export class WhopApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "WhopApiError";
  }
}

export function errorFromReply(reply: WhopReply): WhopApiError {
  const s = reply.status;
  if (s === 401) return new WhopApiError("whop_unauthorized", s, "Whop did not accept LazyRelay's connection.");
  if (s === 403) return new WhopApiError("whop_forbidden", s, "Whop says LazyRelay does not have permission in this community.");
  if (s === 404) return new WhopApiError("whop_not_found", s, "Whop could not find that community or forum.");
  if (s === 409) return new WhopApiError("whop_conflict", s, "Whop reported a conflict.");
  if (s === 422) return new WhopApiError("whop_validation", s, reply.message || "Whop needs something more before it will accept this.");
  if (s === 429) return new WhopApiError("whop_rate_limited", s, "Whop is limiting requests right now.", reply.retryAfterSeconds);
  if (s === 400) return new WhopApiError("whop_bad_request", s, reply.message || "Whop did not accept the request.");
  if (s >= 500) return new WhopApiError("whop_server_error", s, "Whop had a problem.");
  return new WhopApiError(`whop_http_${s}`, s, "Whop sent an unexpected answer.");
}

/** What the scheduler gets back. Always starts with the short code postErrors.ts matches on. Never contains the app
 *  key: the inputs are the action name, a fixed code, a number and (for 400/422 only) Whop's scrubbed message. */
export function failureText(action: string, reply: WhopReply): string {
  const e = errorFromReply(reply);
  const base = `Whop ${action} failed: ${e.code} (HTTP ${reply.status})`;
  if (e.code === "whop_rate_limited") return `${base}${e.retryAfterSeconds ? ` (Whop asks to wait ${e.retryAfterSeconds} seconds)` : ""}`;
  if (e.code === "whop_validation" || e.code === "whop_bad_request") return `${base}: ${reply.message || "no details"}`;
  return base;
}

/** A network failure or timeout, worded so postErrors.ts treats it as temporary. Never includes the raw error. */
export const WHOP_UNREACHABLE = "Could not reach Whop (timed out or network error)";
