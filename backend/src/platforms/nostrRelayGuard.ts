import { isIP } from "node:net";
import { isSafeMediaUrl } from "../urlSafety.js";

// Nostr relay addresses come from places a stranger can write to: the connection token the customer pastes (which
// their signer produced), the relay list a signer returns from switch_relays, and the customer's public NIP-65 relay
// list (anyone can publish a list under any key, but only the owner's signed one is trusted, see nostr.ts). Every one
// of them is therefore treated as hostile input before a socket is opened: only wss:// to a public DNS name on port
// 443, resolved here and then pinned (nostrRelay.ts) to exactly the addresses this check approved, so the name cannot
// answer differently between the check and the connection (DNS rebinding). The address ranges are refused by the same
// guard every other customer-supplied address goes through (urlSafety.ts, including its IPv6 hardening).

/** The most relays any single step (signing, publishing, reading back) talks to. */
export const MAX_RELAYS = 5;

const MAX_URL_LENGTH = 200;
const MAX_HOST_LENGTH = 253;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// A real top level domain is letters (or an xn-- international one). A numeric last label is how IPv4 addresses and
// their odd spellings hide inside a "name", so it is refused outright.
const TLD = /^(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$/;
// Names that only mean something on a private network or are reserved.
const FORBIDDEN_SUFFIXES = [
  "localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp", "private", "test",
  "example", "invalid", "onion", "arpa", "home.arpa",
];

export type RelayUrlCheck = { ok: true; url: string; host: string } | { ok: false; reason: string };

/** Syntax only (no network): turns a relay address into the one canonical form, "wss://host", or says why not. */
export function parseRelayUrl(input: unknown): RelayUrlCheck {
  if (typeof input !== "string") return { ok: false, reason: "not a text address" };
  const raw = input.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return { ok: false, reason: "missing or too long" };
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\@#?]/.test(raw)) return { ok: false, reason: "contains characters a relay address never has" };
  if (!/^wss:\/\//i.test(raw)) return { ok: false, reason: "must start with wss://" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid address" };
  }
  if (url.protocol !== "wss:") return { ok: false, reason: "must use wss://" };
  if (url.username || url.password) return { ok: false, reason: "must not contain a login" };
  if (url.port && url.port !== "443") return { ok: false, reason: "must use the standard port 443" };
  if (url.pathname !== "/" || url.search || url.hash) return { ok: false, reason: "must be a bare host name with no path" };
  const host = url.hostname.toLowerCase();
  if (host.length > MAX_HOST_LENGTH) return { ok: false, reason: "host name too long" };
  // IP literals in any spelling (WHATWG already rewrote 0x7f.1, 2130706433 and [::1] into a canonical IP).
  if (isIP(host.replace(/^\[|\]$/g, ""))) return { ok: false, reason: "must be a name, not an IP address" };
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => !LABEL.test(l))) return { ok: false, reason: "not a public host name" };
  if (!TLD.test(labels[labels.length - 1])) return { ok: false, reason: "not a public host name" };
  if (FORBIDDEN_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return { ok: false, reason: "not a public host name" };
  return { ok: true, url: `wss://${host}`, host };
}

export type GuardedRelay = { url: string; host: string; addresses: string[] };
export type RelayGuardResult = { ok: true; relay: GuardedRelay } | { ok: false; reason: string };

/** Syntax check, then resolve the name and refuse anything that lands on a private, loopback, link-local or
 *  otherwise non-public address. The returned addresses are the ones the socket must be pinned to. */
export async function guardRelay(input: unknown): Promise<RelayGuardResult> {
  const parsed = parseRelayUrl(input);
  if (!parsed.ok) return parsed;
  const safety = await isSafeMediaUrl(`https://${parsed.host}/`);
  if (!safety.safe) return { ok: false, reason: safety.reason };
  return { ok: true, relay: { url: parsed.url, host: parsed.host, addresses: safety.addresses } };
}

/** Canonical, de-duplicated, syntax-valid relay addresses, at most `max`. Entries that fail are silently dropped
 *  (a hostile list must not be able to fail a whole operation); the network check happens later, per relay. */
export function cleanRelayList(input: unknown, max: number = MAX_RELAYS): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    const parsed = parseRelayUrl(item);
    if (parsed.ok && !out.includes(parsed.url)) out.push(parsed.url);
    if (out.length >= max) break;
  }
  return out;
}

/** Guards a list of relays in parallel and keeps only the safe ones (order kept). */
export async function guardRelays(urls: string[], max: number = MAX_RELAYS): Promise<GuardedRelay[]> {
  const results = await Promise.all(cleanRelayList(urls, max).map((u) => guardRelay(u)));
  return results.flatMap((r) => (r.ok ? [r.relay] : []));
}
