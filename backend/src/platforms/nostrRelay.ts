import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import WebSocket from "ws";
import { verifyEvent, type Event as NostrEvent } from "nostr-tools/pure";
import type { GuardedRelay } from "./nostrRelayGuard.js";

// The only place LazyRelay opens a socket to a Nostr relay. Everything that talks to a relay (publishing, reading a
// post back, reading a relay list, the NIP-46 signer channel) goes through RelayConnection so that the limits live in
// one spot and tests can swap the whole network for an in-memory fake (RelayConnector).
//
// Relays are strangers' servers, so every socket has: a connect timeout, a hard overall deadline, a cap on the size of
// one message (ws drops the connection when it is exceeded), no compression (no decompression bombs), no redirects,
// and a connection pinned to the exact addresses the relay guard approved. Callers close what they open in a finally.

export const CONNECT_TIMEOUT_MS = 8_000;
/** One relay message may be at most this big. Kind 1 notes and relay lists are far smaller. */
export const MAX_MESSAGE_BYTES = 128 * 1024;
/** Most events a single read keeps. */
export const MAX_EVENTS_PER_READ = 20;

export interface RelayConnection {
  send(text: string): void;
  close(): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
}

export type RelayConnector = (relay: GuardedRelay) => Promise<RelayConnection>;

/** Pins the TLS connection to the addresses the guard approved (same idea as lemmy.ts / streamUpload.ts). */
function pinnedLookup(addresses: string[]) {
  const candidates = addresses
    .map((address) => ({ address, family: isIP(address) }))
    .filter((c): c is { address: string; family: 4 | 6 } => c.family === 4 || c.family === 6);
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void,
  ) => {
    if (candidates.length === 0) return callback(new Error("no valid pinned address"), "", 0);
    if (options.all) return callback(null, candidates);
    return callback(null, candidates[0].address, candidates[0].family);
  };
}

/** Opens one socket pinned to `addresses`. Rejects (with no details, they can echo the address) when the relay does not
 *  open within the timeout. `tls` is only ever passed by the test that talks to a local server with its own certificate. */
export function openRelaySocket(url: string, addresses: string[], tls: { ca?: string } = {}): Promise<RelayConnection> {
  return new Promise<RelayConnection>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url, {
      ...tls,
      lookup: pinnedLookup(addresses) as never,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      followRedirects: false,
      maxRedirects: 0,
      headers: { "User-Agent": "LazyRelay/1.0 (+https://lazyrelay.com)" },
    });
    const messageHandlers: Array<(text: string) => void> = [];
    const closeHandlers: Array<() => void> = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as Buffer).toString("utf8");
      for (const h of messageHandlers) h(text);
    });
    ws.on("close", () => {
      for (const h of closeHandlers) h();
    });
    ws.on("error", () => {
      // Deliberately no error text: it can contain the address. A failed open rejects, a later error just ends the socket.
      if (!settled) {
        settled = true;
        reject(new Error("relay unreachable"));
      }
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
    });
    ws.on("unexpected-response", () => {
      if (!settled) {
        settled = true;
        reject(new Error("relay unreachable"));
      }
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
    });
    ws.on("open", () => {
      settled = true;
      resolve({
        send: (text) => ws.send(text),
        close: () => {
          try {
            ws.terminate();
          } catch {
            /* already closed */
          }
        },
        onMessage: (h) => void messageHandlers.push(h),
        onClose: (h) => void closeHandlers.push(h),
      });
    });
  });
}

/** The real connector: a ws socket to wss://host on port 443, pinned to the addresses the guard approved. */
export const defaultRelayConnector: RelayConnector = (relay) => openRelaySocket(`${relay.url}/`, relay.addresses);

const randomSubscriptionId = () => randomBytes(8).toString("hex");

/** Short machine codes from a relay's OK / CLOSED message (NIP-01: "prefix: human text"). Only a prefix from this
 *  list is ever kept, the human text is dropped so nothing a relay writes reaches an error message or a log. */
const RELAY_CODES = ["duplicate", "pow", "blocked", "rate-limited", "invalid", "restricted", "mute", "error", "auth-required"] as const;
export type RelayCode = (typeof RELAY_CODES)[number] | "unknown" | "invalid-time";

export function relayCodeOf(message: unknown): RelayCode {
  if (typeof message !== "string") return "unknown";
  const prefix = /^([a-z-]{2,20}):/.exec(message.trim().toLowerCase())?.[1];
  const code = (RELAY_CODES as readonly string[]).includes(prefix ?? "") ? (prefix as RelayCode) : "unknown";
  // "invalid: event creation date is too far off ..." is the one case where the reason matters: a clock problem, not a bad event.
  if (code === "invalid" && /created_at|creation date|too far|timestamp|in the future|too old|clock/.test(message.toLowerCase())) return "invalid-time";
  return code;
}

export interface PublishOutcome {
  relay: string;
  /** False when no socket could be opened or nothing was answered. */
  reachable: boolean;
  accepted: boolean;
  code: RelayCode | null;
}

function parseMessage(text: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Sends one event to one relay and waits for its OK. A socket is opened, used and closed inside this call. The relay's
 *  answer only ever means "this relay accepted the message": it is never proof the post exists (see readEventById). */
export async function publishToRelay(
  connect: RelayConnector,
  relay: GuardedRelay,
  event: NostrEvent,
  timeoutMs: number,
): Promise<PublishOutcome> {
  let conn: RelayConnection | null = null;
  try {
    conn = await connect(relay);
  } catch {
    return { relay: relay.url, reachable: false, accepted: false, code: null };
  }
  const c = conn;
  return new Promise<PublishOutcome>((resolve) => {
    let done = false;
    const finish = (outcome: PublishOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      c.close();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ relay: relay.url, reachable: true, accepted: false, code: null }), timeoutMs);
    c.onClose(() => finish({ relay: relay.url, reachable: true, accepted: false, code: null }));
    c.onMessage((text) => {
      const msg = parseMessage(text);
      if (!msg || msg[0] !== "OK" || msg[1] !== event.id) return; // only the answer to OUR event counts
      const accepted = msg[2] === true;
      finish({ relay: relay.url, reachable: true, accepted, code: accepted ? null : relayCodeOf(msg[3]) });
    });
    try {
      c.send(JSON.stringify(["EVENT", event]));
    } catch {
      finish({ relay: relay.url, reachable: false, accepted: false, code: null });
    }
  });
}

export interface ReadOutcome {
  relay: string;
  /** True once the relay answered the request (EOSE or an event), false when nothing could be read from it. */
  reachable: boolean;
  /** Events the relay returned that pass the full NIP-01 check (id is the hash, signature is valid), newest first. */
  events: NostrEvent[];
}

/** Asks one relay for events matching `filter` over a fresh connection, then closes it. Returns only events whose id
 *  and signature verify; what the relay claims about them is not trusted. Reads at most MAX_EVENTS_PER_READ. */
export async function readFromRelay(
  connect: RelayConnector,
  relay: GuardedRelay,
  filter: Record<string, unknown>,
  timeoutMs: number,
): Promise<ReadOutcome> {
  let conn: RelayConnection | null = null;
  try {
    conn = await connect(relay);
  } catch {
    return { relay: relay.url, reachable: false, events: [] };
  }
  const c = conn;
  const subId = randomSubscriptionId();
  return new Promise<ReadOutcome>((resolve) => {
    const events: NostrEvent[] = [];
    let reachable = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        c.send(JSON.stringify(["CLOSE", subId]));
      } catch {
        /* the socket is about to be closed anyway */
      }
      c.close();
      resolve({ relay: relay.url, reachable, events: events.sort((a, b) => b.created_at - a.created_at) });
    };
    const timer = setTimeout(finish, timeoutMs);
    c.onClose(finish);
    c.onMessage((text) => {
      const msg = parseMessage(text);
      if (!msg || msg[1] !== subId) return; // another subscription's traffic, ignore
      if (msg[0] === "EOSE" || msg[0] === "CLOSED") {
        reachable = reachable || msg[0] === "EOSE";
        finish();
        return;
      }
      if (msg[0] !== "EVENT") return;
      reachable = true;
      const ev = asVerifiedEvent(msg[2]);
      if (ev && events.length < MAX_EVENTS_PER_READ) events.push(ev);
      if (events.length >= MAX_EVENTS_PER_READ) finish();
    });
    try {
      c.send(JSON.stringify(["REQ", subId, filter]));
    } catch {
      finish();
    }
  });
}

/** Structural NIP-01 check plus id and signature verification. Returns a clean copy (only the six NIP-01 fields) or null. */
export function asVerifiedEvent(value: unknown): NostrEvent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" || !/^[0-9a-f]{64}$/.test(v.id) ||
    typeof v.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(v.pubkey) ||
    typeof v.sig !== "string" || !/^[0-9a-f]{128}$/.test(v.sig) ||
    typeof v.kind !== "number" || !Number.isInteger(v.kind) || v.kind < 0 || v.kind > 65535 ||
    typeof v.created_at !== "number" || !Number.isInteger(v.created_at) || v.created_at < 0 ||
    typeof v.content !== "string" ||
    !Array.isArray(v.tags) || v.tags.length > 2000 ||
    !v.tags.every((t) => Array.isArray(t) && t.length <= 50 && t.every((x) => typeof x === "string"))
  ) {
    return null;
  }
  // A fresh object: verifyEvent caches its answer on the object it is given, so never hand it one that came off the wire.
  const clean: NostrEvent = { id: v.id, pubkey: v.pubkey, created_at: v.created_at, kind: v.kind, tags: (v.tags as string[][]).map((t) => [...t]), content: v.content, sig: v.sig };
  try {
    return verifyEvent(clean) ? clean : null;
  } catch {
    return null;
  }
}
