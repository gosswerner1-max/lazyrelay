import { randomBytes } from "node:crypto";
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { asVerifiedEvent, type RelayConnection, type RelayConnector } from "./nostrRelay.js";
import { cleanRelayList, type GuardedRelay } from "./nostrRelayGuard.js";

// NIP-46 (Nostr Remote Signing), client side. The customer's private key stays inside their own signer app (a
// "bunker"); LazyRelay holds a disposable client keypair and a connection token, nothing else. Everything below follows
// the current text of NIP-46 (read 2026-10-01, last edited 2026-07-15):
//   - the token is bunker://<remote-signer-pubkey>?relay=wss://...&secret=<optional>   (the pubkey is the SIGNER's,
//     not the user's: the user's comes from get_public_key after connect)
//   - requests are kind 24133 events, content = NIP-44 encrypted JSON {id, method, params}, p-tagging the signer
//   - responses are kind 24133 events from the signer, p-tagging the client, content = NIP-44 encrypted
//     {id, result, error?}; `result: "auth_url"` with a URL in `error` is an auth challenge, the real answer follows
//     later under the same request id
//   - connect params are [signer pubkey, secret, requested permissions, client metadata JSON]; the answer is "ack" or the secret
// Kind 24133 is ephemeral (NIP-01): relays do not store it, so the subscription for the answer is opened BEFORE the
// request is sent.

/** What we ask the signer to allow, and nothing more: sign plain text notes (kind 1) and tell us the public key. */
export const REQUESTED_PERMISSIONS = "sign_event:1,get_public_key";
const CLIENT_METADATA = JSON.stringify({ name: "LazyRelay", url: "https://lazyrelay.com" });

const MAX_RESPONSE_EVENTS = 50;
export const MAX_TOKEN_LENGTH = 2000;
const MAX_SECRET_LENGTH = 512;

export const PRIVATE_KEY_REFUSED_MESSAGE =
  "That looks like a private key (or a recovery phrase). LazyRelay never accepts one and never needs one, so please do not paste it anywhere. Open your Nostr signer app instead (for example Amber, nsec.app or Alby), create a connection there, and paste the link that starts with bunker://.";

// ---------------------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------------------

/** True when the text looks like a raw private key or recovery phrase: an nsec, an encrypted ncryptsec, a bare 64
 *  character hex secret, or 12 to 24 plain words. Used at the connect step in the backend AND the frontend (same rules,
 *  frontend/src/lib/nostrSecrets.ts). A bunker:// link is never mistaken for one: it has a scheme and punctuation. */
export function looksLikeSecretKey(input: string): boolean {
  const text = input.trim();
  if (/nsec1[02-9ac-hj-np-z]{20,}/i.test(text) || /ncryptsec1[02-9ac-hj-np-z]{20,}/i.test(text)) return true;
  if (/^(0x)?[0-9a-f]{64}$/i.test(text)) return true;
  if (/^[a-z]+(\s+[a-z]+){11,23}$/i.test(text) && [12, 15, 18, 21, 24].includes(text.split(/\s+/).length)) return true;
  return false;
}

export interface BunkerToken {
  signerPubkey: string;
  relays: string[];
  secret: string | null;
}
export type BunkerParse = { ok: true; token: BunkerToken } | { ok: false; error: string };

/** Parses and validates a bunker:// token. Error messages are plain language and never repeat the input. */
export function parseBunkerToken(input: unknown): BunkerParse {
  if (typeof input !== "string" || !input.trim()) return { ok: false, error: "Paste the connection link from your signer app. It starts with bunker://" };
  const text = input.trim();
  // Checked before anything else, on the raw text, so a secret is refused whatever else is wrong with it.
  if (looksLikeSecretKey(text)) return { ok: false, error: PRIVATE_KEY_REFUSED_MESSAGE };
  if (text.length > MAX_TOKEN_LENGTH) return { ok: false, error: "That connection link is too long." };
  if (/^nostrconnect:\/\//i.test(text)) {
    return { ok: false, error: "That is a nostrconnect:// link. LazyRelay needs the link that starts with bunker://. In your signer app look for the option to copy a bunker link." };
  }
  const match = /^bunker:\/\/([0-9a-f]{64})\/?\?(.+)$/i.exec(text);
  if (!match) return { ok: false, error: "That does not look like a bunker link. It should start with bunker:// followed by a long code, then ?relay=wss://..." };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(match[2]);
  } catch {
    return { ok: false, error: "That bunker link is damaged. Copy it again from your signer app." };
  }
  const rawRelays = params.getAll("relay");
  if (rawRelays.length === 0) return { ok: false, error: "That bunker link has no relay in it. Copy it again from your signer app." };
  const relays = cleanRelayList(rawRelays);
  if (relays.length === 0) {
    return { ok: false, error: "None of the relays in that bunker link can be used. LazyRelay only connects to public relays whose address starts with wss://." };
  }
  const secret = params.get("secret");
  if (secret !== null && (secret.length > MAX_SECRET_LENGTH || /[\u0000-\u001f\u007f]/.test(secret))) {
    return { ok: false, error: "That bunker link is damaged. Copy it again from your signer app." };
  }
  return { ok: true, token: { signerPubkey: match[1].toLowerCase(), relays, secret: secret || null } };
}

// ---------------------------------------------------------------------------------------
// Signer requests
// ---------------------------------------------------------------------------------------

/** Why a signer request failed. Codes only: nothing the signer or a relay wrote is ever carried in an error. */
export type SignerFailure = "unreachable" | "timeout" | "refused" | "revoked" | "auth_url" | "protocol";

export class SignerError extends Error {
  constructor(readonly failure: SignerFailure, readonly authHost: string | null = null) {
    super(`nostr_signer_${failure}`);
  }
}

/** The signer's own error text decides between "you said no" and "this connection is gone". The text is read here and
 *  dropped: only the resulting code survives. */
function classifySignerError(text: string): SignerFailure {
  const t = text.toLowerCase();
  if (/denied|reject|refus|declin|cancel|not allowed|permission|forbidden/.test(t)) return "refused";
  if (/unauthori|not (connected|authori|paired)|no (such |active )?(session|connection|client)|unknown (client|session|connection)|revoked|expired|invalid secret|already (used|connected)/.test(t)) return "revoked";
  return "protocol";
}

export interface RequestOptions {
  timeoutMs: number;
  /** When the signer answers with an auth challenge: how long to keep waiting for the real answer (the person
   *  approves in their signer app). 0 or absent: fail at once, nobody is there to approve (a scheduled post). */
  authWaitMs?: number;
}

export interface SignerChannelConfig {
  connect: RelayConnector;
  clientSecretKey: Uint8Array;
  signerPubkey: string;
  relays: GuardedRelay[];
  now?: () => number;
}

/** One NIP-46 conversation with one signer over up to five relays. Each request opens fresh sockets, subscribes for
 *  the answer, sends the request, and closes everything when it has an answer, an error or runs out of time. */
export class SignerChannel {
  private readonly conversationKey: Uint8Array;
  private readonly clientPubkey: string;
  private readonly now: () => number;

  constructor(private readonly cfg: SignerChannelConfig) {
    this.conversationKey = nip44.getConversationKey(cfg.clientSecretKey, cfg.signerPubkey);
    this.clientPubkey = getPublicKey(cfg.clientSecretKey);
    this.now = cfg.now ?? (() => Date.now());
  }

  async request(method: string, params: string[], opts: RequestOptions): Promise<string> {
    const requestId = randomBytes(16).toString("hex");
    const createdAt = Math.floor(this.now() / 1000);
    const requestEvent = finalizeEvent(
      {
        kind: 24133,
        created_at: createdAt,
        tags: [["p", this.cfg.signerPubkey]],
        content: nip44.encrypt(JSON.stringify({ id: requestId, method, params }), this.conversationKey),
      },
      this.cfg.clientSecretKey,
    );

    const opened = await Promise.all(this.cfg.relays.map((r) => this.cfg.connect(r).then((c) => c, () => null)));
    const conns = opened.filter((c): c is RelayConnection => c !== null);
    if (conns.length === 0) throw new SignerError("unreachable");

    const subId = randomBytes(8).toString("hex");
    const seen = new Set<string>();
    let eventsRead = 0;
    let rejected = 0;
    let closed = 0;
    let authHost: string | null = null;
    let authSeen = false;

    try {
      return await new Promise<string>((resolve, reject) => {
        let finished = false;
        let timer: NodeJS.Timeout;
        const done = (fn: () => void) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          fn();
        };
        const onTimeout = () => done(() => reject(new SignerError(authSeen ? "auth_url" : "timeout", authHost)));
        timer = setTimeout(onTimeout, opts.timeoutMs);

        const handleResponse = (ev: NostrEvent) => {
          // Only the signer we connected to, only answers addressed to our disposable key.
          if (ev.kind !== 24133 || ev.pubkey !== this.cfg.signerPubkey) return;
          if (!ev.tags.some((t) => t[0] === "p" && t[1] === this.clientPubkey)) return;
          let message: { id?: unknown; result?: unknown; error?: unknown };
          try {
            message = JSON.parse(nip44.decrypt(ev.content, this.conversationKey)) as typeof message;
          } catch {
            return; // not for us, or garbled: ignore
          }
          if (!message || message.id !== requestId) return; // bound to THIS request, anything else is ignored
          if (message.result === "auth_url") {
            authSeen = true;
            authHost = hostOfAuthUrl(message.error) || null;
            if (!opts.authWaitMs) return done(() => reject(new SignerError("auth_url", authHost)));
            clearTimeout(timer);
            timer = setTimeout(onTimeout, opts.authWaitMs);
            return; // keep listening: the real answer arrives under the same id once the person approves
          }
          if (typeof message.error === "string" && message.error) return done(() => reject(new SignerError(classifySignerError(message.error as string))));
          if (typeof message.result === "string") return done(() => resolve(message.result as string));
          done(() => reject(new SignerError("protocol")));
        };

        for (const conn of conns) {
          conn.onClose(() => {
            closed += 1;
            if (closed >= conns.length) done(() => reject(new SignerError(authSeen ? "auth_url" : "unreachable", authHost)));
          });
          conn.onMessage((text) => {
            let msg: unknown;
            try {
              msg = JSON.parse(text);
            } catch {
              return;
            }
            if (!Array.isArray(msg)) return;
            if (msg[0] === "OK" && msg[1] === requestEvent.id) {
              if (msg[2] === false) {
                rejected += 1;
                if (rejected >= conns.length) done(() => reject(new SignerError("unreachable")));
              }
              return;
            }
            if (msg[0] !== "EVENT" || msg[1] !== subId) return;
            const ev = asVerifiedEvent(msg[2]);
            if (!ev || seen.has(ev.id)) return;
            seen.add(ev.id);
            eventsRead += 1;
            if (eventsRead > MAX_RESPONSE_EVENTS) return done(() => reject(new SignerError("protocol")));
            handleResponse(ev);
          });
          try {
            // Subscribe first: the answer is an ephemeral event that is not stored anywhere.
            conn.send(JSON.stringify(["REQ", subId, { kinds: [24133], authors: [this.cfg.signerPubkey], "#p": [this.clientPubkey], since: createdAt - 10 }]));
            conn.send(JSON.stringify(["EVENT", requestEvent]));
          } catch {
            closed += 1;
            if (closed >= conns.length) done(() => reject(new SignerError("unreachable")));
          }
        }
      });
    } finally {
      for (const conn of conns) {
        try {
          conn.send(JSON.stringify(["CLOSE", subId]));
        } catch {
          /* closing anyway */
        }
        conn.close();
      }
    }
  }
}

/** The signer's auth page address, reduced to a host name (never the full URL, which could be anything), or "" . */
function hostOfAuthUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000) return "";
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password ? u.hostname.toLowerCase().slice(0, 100) : "";
  } catch {
    return "";
  }
}

export const isHex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
