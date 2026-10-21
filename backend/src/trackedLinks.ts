// Link Tracking Engine helpers (2026-10-21). A tracked link is a short code on our own domain that redirects to a page on lazyrelay.com or
// timeajob.com and counts the visit. Nothing here talks to the database. See migration 0146 for the tables and the privacy rules
// (nothing about the visitor is stored; only raw click volume is counted, unique counting is permanently off).

import { randomBytes } from "node:crypto";

/** Where a visitor goes when a code is unknown, malformed or the database is down: never an error page. */
export const HOME_URL = "https://lazyrelay.com/";

export const CODE_RE = /^[A-Za-z0-9_-]{6,16}$/;
export const PLATFORM_RE = /^[a-z0-9_]{2,30}$/;

const ALLOWED_HOSTS = new Set(["lazyrelay.com", "www.lazyrelay.com", "timeajob.com", "www.timeajob.com"]);
const MAX_URL_LENGTH = 2048;

/** The one gate every destination passes, on the way in (creating a link) and again on the way out (the redirect).
 *  https only, our two domains only (www or bare), no credentials, no port. Returns the normalised address or null. */
export function parseDestination(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_URL_LENGTH) return null;
  // Whitespace, control characters, backslashes and anything non-ASCII are where parser differences hide open redirects.
  if (!/^[\x21-\x7e]+$/.test(input) || input.includes("\\")) return null;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !ALLOWED_HOSTS.has(u.hostname)) return null;
  return u.href.length <= MAX_URL_LENGTH ? u.href : null;
}

// "bot" is matched on its own except inside "Cubot" (a real phone brand); the rest are preview fetchers of the networks LazyRelay posts to.
const BOT_RE = /(?<!cu)bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|whatsapp|curl|wget|python-requests|python-urllib|httpclient|headless|go-http-client|okhttp|mastodon|cardyb|lemmy|tumblr|iframely|onebox|inspectiontool|node-fetch|axios|java\/|libwww|scrapy|meta-external/i;

/** Link-preview fetchers and crawlers open a link the moment it is posted. They are redirected like anyone else but never counted. */
export function isBotUserAgent(ua: string | undefined): boolean {
  if (!ua) return true; // real browsers always send one
  return BOT_RE.test(ua);
}

/** 8 URL-safe characters (48 random bits). Creation retries on the rare collision. */
export function newCode(): string {
  return randomBytes(6).toString("base64url");
}
