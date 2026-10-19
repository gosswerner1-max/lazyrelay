// Content Sources, the thin client side. This file is the form's rules, the one place that knows how a Content Sources
// draft is recognised (the cs: tag), and the small client the tab talks to. Nothing here reads, parses or rewrites a feed,
// a sitemap or a CSV: all of that lives in a separate private service. Until that service has an address
// (VITE_CONTENT_SOURCES_API_URL) the default client answers "Not connected yet" and makes no network call.

import type { ScheduledPost } from "./api";

export type SourceType = "rss" | "sitemap" | "csv";

export const SOURCE_TYPES: SourceType[] = ["rss", "sitemap", "csv"];
export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  rss: "RSS Feed",
  sitemap: "Sitemap XML",
  csv: "CSV Bulk Upload",
};

export const URL_MAX_LENGTH = 2048;
export const CSV_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const TITLE_MAX_LENGTH = 120;

export type SourceInput =
  | { type: "rss" | "sitemap"; url: string; brandId: string | null }
  | { type: "csv"; file: File; brandId: string | null };

export type VerifyResult =
  | { status: "verified" }
  | { status: "failed"; reason: string }
  | { status: "not_connected" };

export type AddResult = { status: "added" } | { status: "failed"; reason: string } | { status: "not_connected" };

export interface ContentSourcesClient {
  verifySource(input: SourceInput): Promise<VerifyResult>;
  addSource(input: SourceInput): Promise<AddResult>;
}

/** The origin of a draft: which kind of source made it and the source's name. */
export interface DraftOrigin {
  type: SourceType | null;
  name: string;
}

export interface DraftRow {
  id: string;
  origin: DraftOrigin;
  title: string;
  post: ScheduledPost;
}

type Validation<T> = ({ ok: true } & T) | { ok: false; error: string };

// ---------- Validators ----------

function ipv4Blocked(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function ipv6Blocked(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique local
  // An IPv4 address written inside an IPv6 one. The address parser rewrites ::ffff:1.2.3.4 as ::ffff:102:304.
  const embedded = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (embedded) {
    const hi = parseInt(embedded[1], 16);
    return ipv4Blocked(hi >> 8, hi & 255);
  }
  const dotted = h.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) return ipv4Blocked(Number(dotted[1]), Number(dotted[2]));
  return false;
}

/** True for localhost and for private, loopback and link-local address literals. */
function hostIsInternal(hostname: string): boolean {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("[") && host.endsWith("]")) return ipv6Blocked(host.slice(1, -1));
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return ipv4Blocked(Number(v4[1]), Number(v4[2]));
  return false;
}

/** The address field's rules. The service re-checks everything; this only spares the customer a round trip. */
export function validateSourceUrl(raw: string): Validation<{ url: string }> {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Enter the web address first." };
  if (value.length > URL_MAX_LENGTH) return { ok: false, error: `That address is too long. Use ${URL_MAX_LENGTH} characters or fewer.` };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: "That does not look like a web address. Start it with https://" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "Use a secure address that starts with https://" };
  if (parsed.username || parsed.password) return { ok: false, error: "Remove the username and password from the address." };
  if (hostIsInternal(parsed.hostname)) return { ok: false, error: "Use the public address of your site, not a private or local one." };
  return { ok: true, url: value };
}

/** The CSV picker's rules: a .csv file, not empty, and not over the size cap. */
export function validateCsvFile(file: { name: string; size: number }): Validation<object> {
  if (!/\.csv$/i.test(file.name)) return { ok: false, error: "Choose a file that ends in .csv." };
  if (file.size === 0) return { ok: false, error: "That file is empty. Choose a CSV file with some rows in it." };
  if (file.size > CSV_MAX_BYTES) return { ok: false, error: `That file is too big. The limit is ${CSV_MAX_BYTES / (1024 * 1024)} MB.` };
  return { ok: true };
}

export function describeVerifyResult(result: VerifyResult): string {
  switch (result.status) {
    case "verified":
      return "Verified. This source can be read.";
    case "failed":
      return `Could not verify. ${result.reason}`;
    case "not_connected":
      return "Not connected yet. Source checks are not switched on for your account.";
  }
}

// ---------- Recognising the drafts this feature made ----------
// Content Sources drafts are ordinary LazyRelay drafts. They are told apart by a tag shaped cs:<type>:<name>
// (for example cs:rss:My blog). Verified in backend/src: POST /scheduled-posts/draft and PATCH /scheduled-posts/:id accept
// `tags`, but normalizeTags lowercases each tag and caps it at 30 characters (5 tags per post), so the name arrives
// lowercase and short. If the tag format ever changes, this section is the only place that has to.

const TAG_PREFIX = "cs:";

export function originFromTags(tags: readonly string[] | null | undefined): DraftOrigin | null {
  const tag = (tags ?? []).find((t) => t.toLowerCase().startsWith(TAG_PREFIX));
  if (tag === undefined) return null;
  const rest = tag.slice(TAG_PREFIX.length);
  const colon = rest.indexOf(":");
  const typeText = (colon === -1 ? rest : rest.slice(0, colon)).toLowerCase();
  const name = colon === -1 ? "" : rest.slice(colon + 1);
  const type = (SOURCE_TYPES as string[]).includes(typeText) ? (typeText as SourceType) : null;
  return { type, name };
}

/** The extracted headline: the first non-empty line of the draft text. */
export function draftTitle(content: string): string {
  const line = content.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).find((l) => l !== "");
  if (!line) return "Untitled draft";
  return line.length > TITLE_MAX_LENGTH ? `${line.slice(0, TITLE_MAX_LENGTH - 3)}...` : line;
}

/** From the account's posts, only the drafts a content source made (still waiting for a person). */
export function contentSourceDrafts(posts: readonly ScheduledPost[]): DraftRow[] {
  const rows: DraftRow[] = [];
  for (const post of posts) {
    if (post.status !== "draft" && post.status !== "needs_approval") continue;
    const origin = originFromTags(post.tags);
    if (!origin) continue;
    rows.push({ id: post.id, origin, title: draftTitle(post.content), post });
  }
  return rows;
}

// ---------- The client ----------

const NOT_CONNECTED = { status: "not_connected" } as const;

/**
 * Without an address: every call answers "Not connected yet" and nothing goes over the network.
 * With one: PROVISIONAL contract, POST <address>/verify and POST <address>/sources with JSON ({type, url, brandId}) or, for a
 * CSV, form data. The service does not exist yet, so this has only been exercised with a fake fetch. Change it with the service.
 */
export function createContentSourcesClient(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch): ContentSourcesClient {
  const base = baseUrl?.trim().replace(/\/+$/, "");
  if (!base) {
    return { verifySource: async () => NOT_CONNECTED, addSource: async () => NOT_CONNECTED };
  }

  async function send(path: string, input: SourceInput): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const init: RequestInit =
        input.type === "csv"
          ? { method: "POST", body: csvForm(input) }
          : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: input.type, url: input.url, brandId: input.brandId }) };
      const res = await fetchImpl(`${base}${path}`, init);
      if (!res.ok) return { ok: false, reason: "The source service could not do that right now. Try again in a moment." };
      const body = (await res.json()) as { ok?: boolean; reason?: string };
      return body.ok ? { ok: true } : { ok: false, reason: body.reason ?? "The source service did not accept it." };
    } catch (err) {
      console.error(err); // the raw error stays visible in the console; the customer gets the plain sentence
      return { ok: false, reason: "The source service could not be reached. Try again in a moment." };
    }
  }

  return {
    async verifySource(input) {
      const r = await send("/verify", input);
      return r.ok ? { status: "verified" } : { status: "failed", reason: r.reason };
    },
    async addSource(input) {
      const r = await send("/sources", input);
      return r.ok ? { status: "added" } : { status: "failed", reason: r.reason };
    },
  };
}

function csvForm(input: Extract<SourceInput, { type: "csv" }>): FormData {
  const form = new FormData();
  form.append("type", "csv");
  form.append("file", input.file);
  if (input.brandId) form.append("brandId", input.brandId);
  return form;
}

/** The address comes from the build setting only. Unset means no service yet. */
export const defaultContentSourcesClient: ContentSourcesClient = createContentSourcesClient(
  import.meta.env.VITE_CONTENT_SOURCES_API_URL as string | undefined,
);
