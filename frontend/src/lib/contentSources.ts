// Content Sources, the thin client side. This file is the form's rules, the one place that knows how a Content Sources
// draft is recognised (the cs: tag), and the client the tab uses to talk to the companion service. Nothing here reads, parses
// or rewrites a feed or a sitemap: that is all the companion service's work. Until the service has an address
// (VITE_CONTENT_SOURCES_API_URL) the tab's client answers "Not connected yet" and makes no network call.

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

/** The two kinds of source the service accepts today. CSV is shown in the form but cannot be added yet. */
export type CreatableSourceType = "rss" | "sitemap";
export type SyncInterval = "hourly" | "every_6_hours" | "every_12_hours" | "daily";
export type VerificationMethod = "well_known" | "meta_tag" | "dns_txt";

/** One source as the service describes it. The proof token is only there while the source still waits for its proof. */
export interface ServiceSource {
  id: string;
  sourceType: SourceType;
  sourceUrl: string | null;
  syncInterval: SyncInterval;
  brandId: string | null;
  lastSyncedAt: string | null;
  domainVerified: boolean;
  verificationMethod: VerificationMethod | null;
  lastError: string | null;
  consecutiveFailures: number;
  verificationToken: string | null;
}

/** The three ways to prove the website is the customer's, with the exact text to publish for each. */
export interface Verification {
  token: string;
  methods: {
    well_known: { url: string; content: string };
    meta_tag: { html: string; placement: string };
    dns_txt: { name: string; value: string };
  };
}

export type VerifyOutcome =
  | { verified: true; method: VerificationMethod }
  | { verified: false; reasons: Record<VerificationMethod, string> };

export interface CredentialStatus {
  registered: boolean;
  keyHint: string | null;
}

export interface NewSource {
  sourceType: CreatableSourceType;
  sourceUrl: string;
  syncInterval?: SyncInterval;
  brandId?: string | null;
}

/** What the tab needs from the companion service. Every method rejects with a ContentSourcesError and nothing else. */
export interface ContentSourcesClient {
  getCredentials(): Promise<CredentialStatus>;
  saveKey(apiKey: string): Promise<{ keyHint: string }>;
  removeKey(): Promise<void>;
  listSources(): Promise<ServiceSource[]>;
  createSource(input: NewSource): Promise<{ source: ServiceSource; verification: Verification }>;
  verifySource(id: string): Promise<VerifyOutcome>;
  updateSource(id: string, patch: { syncInterval?: SyncInterval; brandId?: string | null }): Promise<ServiceSource>;
  deleteSource(id: string): Promise<void>;
  runSource(id: string): Promise<void>;
  /** Is the service up? Needs no sign in. Optional: the Not connected client has none, and the status panel then shows Unknown. */
  ready?(signal?: AbortSignal): Promise<boolean>;
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
export function hostIsInternal(hostname: string): boolean {
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

const KEY_SHAPE = /^lzr_live_[A-Za-z0-9_-]{16,128}$/;

/** The key field's rules, the same shape check the service makes. It does not say whether LazyRelay accepts the key. */
export function validateApiKey(raw: string): Validation<{ key: string }> {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Paste your LazyRelay key first." };
  if (!KEY_SHAPE.test(value)) return { ok: false, error: "That does not look like a LazyRelay key. It starts with lzr_live_ and has no spaces." };
  return { ok: true, key: value };
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

// ---------- Plain words for errors ----------
// The service sends a stable code and a sentence. Only the code is read: every sentence the customer sees is written here, so
// nothing the service (or anything in between) says can reach the screen, and no message can carry a token or a key.

const CLIENT_ONLY_CODES = ["not_connected", "sign_in", "try_later", "network", "bad_response", "unknown"] as const;

const MESSAGES = {
  not_connected: "Not connected yet. Content Sources is not switched on for your account.",
  sign_in: "Please sign in again to use Content Sources.",
  try_later: "Content Sources is busy right now. Please try again in a moment.",
  network: "We could not reach Content Sources. Check your connection and try again.",
  bad_response: "Content Sources sent an answer we could not read. Please try again in a moment.",
  unknown: "Something went wrong. Please try again in a moment.",
  unauthorized: "Please sign in again to use Content Sources.",
  invalid_request: "That was not accepted. Check what you entered and try again.",
  invalid_json: "That was not accepted. Please try again.",
  invalid_sync_interval: "Choose hourly, every 6 hours, every 12 hours or daily.",
  invalid_brand_id: "That brand is not valid. Choose one from the list.",
  invalid_api_key: "That does not look like a LazyRelay key. It starts with lzr_live_ and has no spaces.",
  api_key_rejected: "LazyRelay did not accept that key. Check it and try again, or make a new one on the API Keys tab.",
  invalid_source_type: "Choose an RSS feed or a sitemap.",
  invalid_source_url: "Enter the full https address of a page on your own website, for example https://example.com/feed.xml.",
  address_not_editable: "The address of a source cannot be changed. Remove it and add it again.",
  plan_limit: "You have reached the number of sources your plan allows. Upgrade your plan to add more.",
  forbidden_origin: "This page is not allowed to use Content Sources. Please contact support.",
  not_found: "That source no longer exists. It has been taken off the list.",
  method_not_allowed: "That action is not available. Please contact support.",
  duplicate_source: "You have already added this address.",
  not_verifiable: "This source does not need a website check.",
  engine_disabled: "Background runs are switched off right now.",
  not_verified: "Prove you own this website first, then run it. Use Check now.",
  no_credential: "Add your LazyRelay key above before running this source.",
  already_running: "This source is already running, or is waiting after a problem. Please try again later.",
  payload_too_large: "That is too large to send. Please shorten it.",
  unsupported_media_type: "That was not accepted. Please try again.",
  internal: "Something went wrong on our side. Please try again in a moment.",
  not_available: "CSV upload is coming soon.",
  unavailable: "We could not do that right now. Please try again in a moment.",
  not_ready: "Content Sources is not ready yet. Please try again in a moment.",
  rate_limited: "Too many requests. Please wait a moment and try again.",
} as const;

export type ContentSourcesErrorCode = keyof typeof MESSAGES;

function messageFor(code: ContentSourcesErrorCode, retryAfterSeconds?: number): string {
  if (code === "rate_limited" && retryAfterSeconds !== undefined) {
    return `Too many requests. Please wait ${retryAfterSeconds} ${retryAfterSeconds === 1 ? "second" : "seconds"} and try again.`;
  }
  return MESSAGES[code];
}

/** The only error the client rejects with. It carries a stable code and a plain sentence, never a token, a key or service text. */
export class ContentSourcesError extends Error {
  readonly code: ContentSourcesErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: ContentSourcesErrorCode, retryAfterSeconds?: number) {
    super(messageFor(code, retryAfterSeconds));
    this.name = "ContentSourcesError";
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

const READY_TIMEOUT_MS = 5000;
const MAX_RETRY_AFTER_SECONDS = 3600;
const CODE_WORD = /^[a-z][a-z0-9_]{0,39}$/;

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined; // the date form is not used by the service
  const seconds = Number(header.trim());
  return seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : undefined;
}

function codeFromStatus(status: number): ContentSourcesErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 413) return "payload_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limited";
  if (status === 501) return "not_available";
  if (status >= 500) return "unavailable";
  return "unknown";
}

async function errorFromResponse(res: Response): Promise<ContentSourcesError> {
  let sent: unknown;
  try {
    const body: unknown = await res.json();
    if (isObject(body)) sent = body.code;
  } catch {
    sent = undefined; // not JSON (a gateway page, for example): the status below still decides, so nothing is hidden
  }
  let code: ContentSourcesErrorCode;
  if (typeof sent === "string" && CODE_WORD.test(sent) && Object.hasOwn(MESSAGES, sent) && !(CLIENT_ONLY_CODES as readonly string[]).includes(sent)) {
    code = sent as ContentSourcesErrorCode;
  } else if (sent === undefined || sent === null) {
    code = codeFromStatus(res.status);
  } else {
    code = "unknown"; // a code this page does not know, or something that is not a code at all
  }
  return new ContentSourcesError(code, code === "rate_limited" ? parseRetryAfter(res.headers.get("retry-after")) : undefined);
}

// ---------- Reading the service's answers ----------

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const stringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const METHODS: VerificationMethod[] = ["well_known", "meta_tag", "dns_txt"];
const INTERVALS: SyncInterval[] = ["hourly", "every_6_hours", "every_12_hours", "daily"];
const bad = () => new ContentSourcesError("bad_response");

function readSource(v: unknown): ServiceSource {
  if (!isObject(v)) throw bad();
  const { id, sourceType, sourceUrl, syncInterval, brandId, lastSyncedAt, domainVerified, verificationMethod, lastError, consecutiveFailures, verificationToken } = v;
  if (
    !isString(id) ||
    !(SOURCE_TYPES as unknown[]).includes(sourceType) ||
    !stringOrNull(sourceUrl) ||
    !(INTERVALS as unknown[]).includes(syncInterval) ||
    !stringOrNull(brandId) ||
    !stringOrNull(lastSyncedAt) ||
    typeof domainVerified !== "boolean" ||
    !(verificationMethod === null || (METHODS as unknown[]).includes(verificationMethod)) ||
    !stringOrNull(lastError) ||
    typeof consecutiveFailures !== "number" ||
    !Number.isFinite(consecutiveFailures) ||
    !(verificationToken === undefined || stringOrNull(verificationToken))
  ) {
    throw bad();
  }
  return {
    id,
    sourceType: sourceType as SourceType,
    sourceUrl,
    syncInterval: syncInterval as SyncInterval,
    brandId,
    lastSyncedAt,
    domainVerified,
    verificationMethod: verificationMethod as VerificationMethod | null,
    lastError,
    consecutiveFailures,
    verificationToken: verificationToken ?? null,
  };
}

function readVerification(v: unknown): Verification {
  if (!isObject(v) || !isString(v.token) || !isObject(v.methods)) throw bad();
  const { well_known: wk, meta_tag: mt, dns_txt: dns } = v.methods;
  if (!isObject(wk) || !isString(wk.url) || !isString(wk.content)) throw bad();
  if (!isObject(mt) || !isString(mt.html) || !isString(mt.placement)) throw bad();
  if (!isObject(dns) || !isString(dns.name) || !isString(dns.value)) throw bad();
  return {
    token: v.token,
    methods: {
      well_known: { url: wk.url, content: wk.content },
      meta_tag: { html: mt.html, placement: mt.placement },
      dns_txt: { name: dns.name, value: dns.value },
    },
  };
}

function readVerifyOutcome(v: unknown): VerifyOutcome {
  if (!isObject(v)) throw bad();
  if (v.verified === true) {
    if (!(METHODS as unknown[]).includes(v.method)) throw bad();
    return { verified: true, method: v.method as VerificationMethod };
  }
  if (v.verified === false && isObject(v.reasons)) {
    const r = v.reasons;
    if (isString(r.well_known) && isString(r.meta_tag) && isString(r.dns_txt)) {
      return { verified: false, reasons: { well_known: r.well_known, meta_tag: r.meta_tag, dns_txt: r.dns_txt } };
    }
  }
  throw bad();
}

function readCredentials(v: unknown): CredentialStatus {
  if (!isObject(v) || typeof v.registered !== "boolean" || !stringOrNull(v.keyHint)) throw bad();
  return { registered: v.registered, keyHint: v.keyHint };
}

// ---------- The session token ----------
// The companion service does not know LazyRelay sign ins. The LazyRelay API hands out a short lived token for it. The token is
// kept in memory only, reused until 30 seconds before it expires, and one request is shared between calls made at once.
// It is never written to storage and never logged.

export interface SessionGrant {
  token: string;
  expiresAt: string;
}

export interface SessionTokenProvider {
  getToken(): Promise<string>;
  /** Forget the kept token, so the next call asks for a new one. */
  invalidate(): void;
}

const EXPIRY_MARGIN_MS = 30_000;

function sessionErrorFor(err: unknown): ContentSourcesError {
  if (err instanceof ContentSourcesError) return err;
  const status = err instanceof Error ? (err as { status?: unknown }).status : undefined;
  if (status === 404) return new ContentSourcesError("not_connected"); // the feature is switched off for now
  if (status === 401) return new ContentSourcesError("sign_in");
  if (status === 503) return new ContentSourcesError("try_later");
  if (err instanceof Error && err.message === "Not signed in") return new ContentSourcesError("sign_in");
  console.error(err); // anything else keeps its raw error in the console; the customer gets the plain sentence
  return new ContentSourcesError(typeof status === "number" ? "internal" : "network");
}

export function createSessionTokenProvider(opts: { fetchSession: () => Promise<SessionGrant>; now?: () => number }): SessionTokenProvider {
  const now = opts.now ?? Date.now;
  let kept: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function ask(): Promise<string> {
    let grant: unknown;
    try {
      grant = await opts.fetchSession();
    } catch (err) {
      throw sessionErrorFor(err);
    }
    if (!isObject(grant) || !isString(grant.token) || grant.token === "" || !isString(grant.expiresAt)) throw bad();
    const expiresAtMs = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAtMs)) throw bad();
    kept = expiresAtMs - EXPIRY_MARGIN_MS > now() ? { token: grant.token, expiresAtMs } : null; // too close to the end to keep
    return grant.token;
  }

  return {
    async getToken() {
      if (kept && now() < kept.expiresAtMs - EXPIRY_MARGIN_MS) return kept.token;
      inFlight ??= ask().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    invalidate() {
      kept = null;
    },
  };
}

// ---------- The service client ----------

function checkedBase(raw: string): string {
  const text = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("The Content Sources address is not a web address.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("The Content Sources address must be a plain https address.");
  }
  return text;
}

/**
 * The client for the companion service: bearer token on every call, JSON, no cookies. Every failure is a ContentSourcesError.
 * Nothing from a response body except its code is ever shown or kept.
 */
export function createServiceClient(opts: {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Called when the service answers 401, so the caller can drop the token it kept. */
  onUnauthorized?: () => void;
}): ContentSourcesClient {
  const base = checkedBase(opts.baseUrl);
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await opts.getToken(); // a failure here is already a ContentSourcesError, and no request has been made
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, credentials: "omit", cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      console.error(err); // the raw error stays visible in the console; it never holds the token
      throw new ContentSourcesError("network");
    }
    if (res.status === 401) opts.onUnauthorized?.();
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  }

  async function json(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await call(method, path, body);
    try {
      return await res.json();
    } catch {
      throw bad(); // the answer is not JSON; nothing from it is echoed
    }
  }

  const sourcePath = (id: string) => `/v1/sources/${encodeURIComponent(id)}`;

  return {
    async getCredentials() {
      return readCredentials(await json("GET", "/v1/credentials"));
    },
    async saveKey(apiKey) {
      const out = await json("POST", "/v1/credentials", { apiKey });
      if (!isObject(out) || !isString(out.keyHint)) throw bad();
      return { keyHint: out.keyHint };
    },
    async removeKey() {
      await call("DELETE", "/v1/credentials");
    },
    async listSources() {
      const out = await json("GET", "/v1/sources");
      if (!isObject(out) || !Array.isArray(out.sources)) throw bad();
      return out.sources.map(readSource);
    },
    async createSource(input) {
      const body: Record<string, unknown> = { sourceType: input.sourceType, sourceUrl: input.sourceUrl };
      if (input.syncInterval !== undefined) body.syncInterval = input.syncInterval;
      if (input.brandId !== undefined) body.brandId = input.brandId;
      const out = await json("POST", "/v1/sources", body);
      if (!isObject(out)) throw bad();
      return { source: readSource(out.source), verification: readVerification(out.verification) };
    },
    async verifySource(id) {
      return readVerifyOutcome(await json("POST", `${sourcePath(id)}/verify`));
    },
    async updateSource(id, patch) {
      const out = await json("PATCH", sourcePath(id), patch);
      if (!isObject(out)) throw bad();
      return readSource(out.source);
    },
    async deleteSource(id) {
      await call("DELETE", sourcePath(id));
    },
    async runSource(id) {
      await call("POST", `${sourcePath(id)}/run`);
    },
    async ready(signal) {
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      const timer = setTimeout(stop, READY_TIMEOUT_MS);
      signal?.addEventListener("abort", stop);
      try {
        const res = await doFetch(`${base}/v1/ready`, { method: "GET", headers: { Accept: "application/json" }, credentials: "omit", cache: "no-store", signal: ctl.signal });
        return res.ok;
      } catch (err) {
        if (!ctl.signal.aborted) console.error(err); // a timeout or a stop is expected; anything else stays visible
        return false;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
      }
    },
  };
}

/** The client used when the service has no address (or an unusable one): every call says Not connected yet, with no network call. */
export function createNotConnectedClient(): ContentSourcesClient {
  const no = (): Promise<never> => Promise.reject(new ContentSourcesError("not_connected"));
  return { getCredentials: no, saveKey: no, removeKey: no, listSources: no, createSource: no, verifySource: no, updateSource: no, deleteSource: no, runSource: no };
}

// ---------- Plain words for the website check and for a source's last problem ----------

export interface VerifyReasonLine {
  method: VerificationMethod;
  label: string;
  text: string;
}

const GENERIC_REASON = "We could not confirm this one yet.";

function wellKnownReason(r: string): string {
  if (/^http status 404\b/.test(r)) return "We could not find the text file. Check that it is at the exact address shown.";
  if (/^http status \d+/.test(r)) return "The text file address answered with an error. Check that anyone can open it.";
  if (/^file is empty/.test(r)) return "The text file is empty. Put the one line shown inside it.";
  if (/^file does not contain/.test(r)) return "The text file is there, but its line does not match. Copy it again exactly.";
  if (/^fetch (failed|refused)/.test(r)) return "We could not open the text file address. Check that it works in a browser.";
  return GENERIC_REASON;
}

function metaTagReason(r: string): string {
  if (/^no matching meta tag/.test(r)) return "We did not find the tag inside the head of your home page.";
  if (/^home page (has no head|could not be parsed)/.test(r)) return "We could not read the top of your home page.";
  if (/^(http status \d+|fetch (failed|refused))/.test(r)) return "We could not open your home page.";
  return GENERIC_REASON;
}

function dnsReason(r: string): string {
  if (/^no matching TXT record/.test(r)) return "We did not find the DNS record yet. New records can take a while to show up.";
  if (/^dns lookup failed/.test(r)) return "We could not look up the DNS record yet. Try again in a few minutes.";
  return GENERIC_REASON;
}

/** Each of the checker's reasons as a plain sentence. A reason that is not recognised becomes a generic line, never raw text. */
export function describeVerifyReasons(reasons: Record<VerificationMethod, string>): VerifyReasonLine[] {
  return [
    { method: "well_known", label: "Text file", text: wellKnownReason(reasons.well_known) },
    { method: "meta_tag", label: "Home page tag", text: metaTagReason(reasons.meta_tag) },
    { method: "dns_txt", label: "DNS record", text: dnsReason(reasons.dns_txt) },
  ];
}

/** A source's last problem. The service stores a short code; this turns it into words. Empty when there is none. */
export function describeLastProblem(code: string | null): string {
  if (!code) return "";
  if (code === "no_credential") return "Your LazyRelay key is missing. Add it above.";
  if (code === "not_verified") return "This website is not proven yet. Use Check now.";
  if (code.startsWith("fetch:")) return "We could not open the address. Check that it is public and still works.";
  if (code.startsWith("parse:")) return "We could not read what is at the address. Check that it is a valid feed or sitemap.";
  if (code === "lazyrelay:bad_key") return "LazyRelay did not accept your saved key. Save a new key above.";
  if (code === "lazyrelay:plan_or_not_allowed") return "Your plan or your key does not allow drafts right now. Check your plan.";
  if (code === "lazyrelay:rate_limited") return "LazyRelay asked us to slow down. We will try again later.";
  if (code === "lazyrelay:bad_request") return "LazyRelay did not accept one of the drafts. We will try again later.";
  if (code === "lazyrelay:upstream") return "LazyRelay could not be reached. We will try again later.";
  if (code === "internal") return "Something went wrong on our side. We will try again later.";
  return "The last run did not finish. We will try again later.";
}
