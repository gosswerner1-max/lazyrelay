import { generateSecretKey, getPublicKey, getEventHash, type Event as NostrEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { NOSTR_DEFAULT_RELAYS, NOSTR_PROOF_VIEWER, NOSTR_TEXT_LIMIT, NOSTR_TEXT_LIMIT_BYTES } from "./nostrConstants.js";
import type { PlatformAdapter, PostRequest, PostAttemptResult, VerifyResult, OAuthExchangeResult } from "./types.js";
import {
  asVerifiedEvent,
  defaultRelayConnector,
  publishToRelay,
  readFromRelay,
  type PublishOutcome,
  type RelayConnector,
} from "./nostrRelay.js";
import { MAX_RELAYS, cleanRelayList, guardRelays, type GuardedRelay } from "./nostrRelayGuard.js";
import {
  PRIVATE_KEY_REFUSED_MESSAGE,
  REQUESTED_PERMISSIONS,
  SignerChannel,
  SignerError,
  isHex64,
  looksLikeSecretKey,
  parseBunkerToken,
} from "./nostrSigner.js";

// Nostr is a protocol, not a company: there is no account to log in to, no API key and nothing to refresh. A customer
// connects THEIR OWN identity through NIP-46 remote signing. The private key never leaves their signer app (Amber,
// nsec.app, Alby and others); LazyRelay holds a disposable client key and a connection token, and asks the signer to
// sign each note. The spec behaviour is in nostrSigner.ts, the relay limits in nostrRelay.ts, the address guard in
// nostrRelayGuard.ts.
//
// Posting: build a kind 1 text note, have the signer sign it (sign_event), check what came back (id, signature,
// author, content), send it to the customer's write relays (NIP-65), and require an OK from at least one.
//
// PROOF OF PUBLISH: a relay's OK only means "I accepted the message". The note counts as live only when a FRESH
// connection to a relay returns the same event by id and its id and signature verify (verifyPublished). A failed
// confirmation after a successful publish is "unconfirmed": the scheduler re-verifies and never calls post() again.
//
// Never logged, never returned to the browser: the client secret key, the bunker secret, the token, event content.

/** How long each step waits. Tests shorten them. */
export interface NostrTimeouts {
  connectApprovalMs: number; // the person may need to tap Approve in their signer app
  signMs: number;
  publishMs: number;
  readMs: number;
}
const DEFAULT_TIMEOUTS: NostrTimeouts = { connectApprovalMs: 60_000, signMs: 25_000, publishMs: 10_000, readMs: 8_000 };
const RELAY_LIST_TTL_MS = 6 * 60 * 60_000;
const SIGNED_AT_TOLERANCE_S = 600;
const MAX_SIGNED_EVENT_CHARS = 200_000;
const MAX_REMEMBERED_POSTS = 500;
const REMEMBER_MS = 60 * 60_000;

/** What is saved (encrypted in Vault) for one connection. Connection secrets: the disposable client key and the bunker
 *  secret. NOT the customer's key, which LazyRelay never sees. */
interface NostrCredentials {
  v: 1;
  clientSecretKey: string; // hex, disposable key made at connect time, used only to talk to the signer
  signerPubkey: string;
  userPubkey: string;
  signerRelays: string[];
  writeRelays: string[];
  bunkerSecret: string | null;
}

/** A failure whose message is already safe and readable for the customer (connect step). */
class NostrConnectError extends Error {}

const shortNpub = (pubkeyHex: string): string => {
  const npub = nip19.npubEncode(pubkeyHex);
  return `${npub.slice(0, 9)}...${npub.slice(-4)}`;
};

function parseCredentials(accessToken: string): NostrCredentials | null {
  try {
    const c = JSON.parse(accessToken) as Partial<NostrCredentials>;
    if (c.v !== 1 || !isHex64(c.clientSecretKey) || !isHex64(c.signerPubkey) || !isHex64(c.userPubkey)) return null;
    const signerRelays = cleanRelayList(c.signerRelays);
    if (signerRelays.length === 0) return null;
    return {
      v: 1,
      clientSecretKey: c.clientSecretKey,
      signerPubkey: c.signerPubkey,
      userPubkey: c.userPubkey,
      signerRelays,
      writeRelays: cleanRelayList(c.writeRelays),
      bunkerSecret: typeof c.bunkerSecret === "string" ? c.bunkerSecret : null,
    };
  } catch {
    return null;
  }
}

const connectMessage = (err: SignerError): string => {
  switch (err.failure) {
    case "unreachable":
      return "LazyRelay could not reach your signer through the relays in that link. Make sure your signer app is open and online, then copy a fresh link and try again.";
    case "timeout":
      return "Your signer did not answer in time. Open your signer app, approve the LazyRelay request if it shows one, then try again with a fresh link.";
    case "refused":
      return "Your signer refused the connection. Allow LazyRelay in your signer app, then try again with a fresh link.";
    case "revoked":
      return "Your signer did not accept that link. It may already have been used or have expired. Create a new link in your signer app and try again.";
    case "auth_url":
      return `Your signer wants you to approve LazyRelay on its own page${err.authHost ? ` (${err.authHost})` : ""}. Approve it there, then try again with a fresh link.`;
    default:
      return "Your signer answered in a way LazyRelay did not understand. Try again with a fresh link.";
  }
};

export interface NostrAdapterDeps {
  /** Tests swap the network for an in-memory fake. */
  connector?: RelayConnector;
  now?: () => number;
  timeouts?: Partial<NostrTimeouts>;
}

export class NostrAdapter implements PlatformAdapter {
  readonly platform: "nostr" = "nostr";
  // The customer pastes the token on LazyRelay's own connect page, so there is nothing to confirm afterwards (connect.ts).
  readonly skipConnectConfirmation = true;

  private readonly connect: RelayConnector;
  private readonly now: () => number;
  private readonly t: NostrTimeouts;
  // In memory only: refreshed relay lists, and where each note was accepted (so the read-back asks those relays first).
  private readonly relayLists = new Map<string, { relays: string[]; at: number }>();
  private readonly published = new Map<string, { relays: string[]; at: number }>();

  constructor(private readonly connectPageUrl: string, deps: NostrAdapterDeps = {}) {
    this.connect = deps.connector ?? defaultRelayConnector;
    this.now = deps.now ?? (() => Date.now());
    this.t = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  }

  async getAuthorizeUrl(state: string): Promise<string> {
    const params = new URLSearchParams({ state });
    return `${this.connectPageUrl}?${params.toString()}`;
  }

  // `code` is JSON: {"bunkerUrl": "bunker://..."}. A bare bunker:// string is accepted too (API callers). A private key
  // or recovery phrase is refused before anything else happens, and no message here ever repeats what was pasted.
  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    let pasted: unknown = code;
    try {
      const form = JSON.parse(code) as { bunkerUrl?: unknown };
      if (form && typeof form === "object") pasted = form.bunkerUrl;
    } catch {
      /* not JSON: treat the whole value as the link */
    }
    // A private key anywhere in what was sent (any field of the JSON, or the raw text) ends the connect right here.
    if (looksLikeSecretKey(code) || (pasted !== code && typeof pasted === "string" && looksLikeSecretKey(pasted)) || jsonStringValues(code).some(looksLikeSecretKey)) {
      throw new NostrConnectError(PRIVATE_KEY_REFUSED_MESSAGE);
    }
    const parsed = parseBunkerToken(pasted);
    if (!parsed.ok) throw new NostrConnectError(parsed.error);
    const { token } = parsed;

    try {
      const signerRelays = await guardRelays(token.relays);
      if (signerRelays.length === 0) {
        throw new NostrConnectError("None of the relays in that bunker link can be used. LazyRelay only connects to public relays whose address starts with wss://.");
      }
      // A disposable key just for this conversation. It is not the customer's key and signs nothing they will ever see.
      const clientSecretKey = generateSecretKey();
      const channel = new SignerChannel({ connect: this.connect, clientSecretKey, signerPubkey: token.signerPubkey, relays: signerRelays, now: this.now });

      // 1. connect (with the secret, the permissions we need and who we are). Answer: "ack" or the secret itself.
      const ack = await channel.request("connect", [token.signerPubkey, token.secret ?? "", REQUESTED_PERMISSIONS, JSON.stringify({ name: "LazyRelay", url: "https://lazyrelay.com" })], {
        timeoutMs: this.t.connectApprovalMs,
        authWaitMs: this.t.connectApprovalMs,
      });
      if (ack !== "ack" && !(token.secret && ack === token.secret)) throw new SignerError("protocol");

      // 2. the USER's public key (NIP-46: the signer's key and the user's key can differ, so it is always asked for).
      const userPubkey = await channel.request("get_public_key", [], { timeoutMs: this.t.signMs, authWaitMs: this.t.connectApprovalMs });
      if (!isHex64(userPubkey)) throw new SignerError("protocol");

      // 3. switch_relays: the signer decides which relays the conversation lives on. Optional, failures are ignored.
      let conversationRelays = token.relays;
      try {
        const reply = await channel.request("switch_relays", [], { timeoutMs: Math.min(10_000, this.t.signMs) });
        const list: unknown = reply && reply !== "null" ? JSON.parse(reply) : null;
        const switched = cleanRelayList(list);
        if (switched.length > 0) conversationRelays = switched;
      } catch {
        /* an unsupported or slow switch_relays never blocks connecting */
      }

      // 4. the customer's own relay list (NIP-65), so notes go where their followers read.
      const writeRelays = await this.fetchWriteRelays(userPubkey, [...NOSTR_DEFAULT_RELAYS, ...conversationRelays]);

      const creds: NostrCredentials = {
        v: 1,
        clientSecretKey: bytesToHex(clientSecretKey),
        signerPubkey: token.signerPubkey,
        userPubkey,
        signerRelays: conversationRelays,
        writeRelays,
        bunkerSecret: token.secret,
      };
      console.log(`[nostr] connected: signer relays=${conversationRelays.length} write relays=${writeRelays.length}`);
      return {
        accessToken: JSON.stringify(creds),
        refreshToken: null,
        expiresAt: null,
        platformAccountId: userPubkey,
        displayName: shortNpub(userPubkey),
      };
    } catch (err) {
      if (err instanceof NostrConnectError) throw err;
      if (err instanceof SignerError) throw new NostrConnectError(connectMessage(err));
      // Never err.message here: it could carry text from a relay or the signer.
      throw new NostrConnectError("Could not connect to your Nostr signer. Check the link and try again.");
    }
  }

  /** The customer's write relays from their newest NIP-65 list (kind 10002) found on `candidates`. Only a list that
   *  is signed by the customer's own key counts: anyone can publish a list under any name. */
  private async fetchWriteRelays(userPubkey: string, candidates: string[]): Promise<string[]> {
    const relays = await guardRelays([...new Set(candidates)], MAX_RELAYS);
    const reads = await Promise.all(relays.map((r) => readFromRelay(this.connect, r, { kinds: [10002], authors: [userPubkey], limit: 1 }, this.t.readMs)));
    const newest = reads
      .flatMap((r) => r.events)
      .filter((e) => e.kind === 10002 && e.pubkey === userPubkey)
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (!newest) return [];
    // An r tag with no marker is both read and write; "read" alone is not somewhere we publish.
    const urls = newest.tags.filter((t) => t[0] === "r" && typeof t[1] === "string" && (t[2] === undefined || t[2] === "" || t[2] === "write")).map((t) => t[1]);
    return cleanRelayList(urls);
  }

  /** Where this customer's notes are sent: their NIP-65 write relays (refreshed at most every six hours, kept in
   *  memory), else what was saved at connect, else the signer's relays plus the default list. Always guarded. */
  private async publishRelays(creds: NostrCredentials): Promise<GuardedRelay[]> {
    const cached = this.relayLists.get(creds.userPubkey);
    let write: string[];
    if (cached && this.now() - cached.at < RELAY_LIST_TTL_MS) {
      write = cached.relays;
    } else {
      const fresh = await this.fetchWriteRelays(creds.userPubkey, [...NOSTR_DEFAULT_RELAYS, ...creds.signerRelays]).catch(() => []);
      write = fresh.length > 0 ? fresh : creds.writeRelays;
      this.relayLists.set(creds.userPubkey, { relays: write, at: this.now() });
    }
    const list = write.length > 0 ? write : [...creds.signerRelays, ...NOSTR_DEFAULT_RELAYS];
    return guardRelays([...new Set(list)], MAX_RELAYS);
  }

  async post(request: PostRequest): Promise<PostAttemptResult> {
    const fail = (errorMessage: string): PostAttemptResult => ({ success: false, platformPostId: null, errorMessage });
    const creds = parseCredentials(request.accessToken);
    if (!creds) return fail("nostr_bad_connection");
    if (request.mediaUrl || (request.mediaUrls?.length ?? 0) > 0) return fail("nostr_text_only");
    const content = (request.content ?? "").trim();
    if (!content) return fail("nostr_empty");
    if (content.length > NOSTR_TEXT_LIMIT || Buffer.byteLength(content, "utf8") > NOSTR_TEXT_LIMIT_BYTES) return fail("nostr_too_long");

    try {
      const signerRelays = await guardRelays(creds.signerRelays);
      if (signerRelays.length === 0) return fail("nostr_signer_unreachable");
      const createdAt = Math.floor(this.now() / 1000);
      const channel = new SignerChannel({
        connect: this.connect,
        clientSecretKey: hexToBytes(creds.clientSecretKey),
        signerPubkey: creds.signerPubkey,
        relays: signerRelays,
        now: this.now,
      });

      // 1. have the signer sign it. No human is waiting: an auth challenge fails at once instead of hanging.
      let signedRaw: string;
      try {
        signedRaw = await channel.request("sign_event", [JSON.stringify({ kind: 1, content, tags: [], created_at: createdAt })], { timeoutMs: this.t.signMs });
      } catch (err) {
        if (err instanceof SignerError) return fail(err.message);
        return fail("nostr_signer_unreachable");
      }

      // 2. never trust the signer's answer: it must be exactly the note we asked for, by the customer's key.
      const event = this.checkSignedEvent(signedRaw, creds.userPubkey, content);
      if (!event) return fail("nostr_signer_bad_event");

      // 3. send it to the customer's write relays, one fresh connection each, and require an OK from at least one.
      const relays = await this.publishRelays(creds);
      if (relays.length === 0) return fail("nostr_relays_unreachable");
      const outcomes = await Promise.all(relays.map((r) => publishToRelay(this.connect, r, event, this.t.publishMs)));
      const accepted = outcomes.filter((o) => o.accepted);
      if (accepted.length > 0) {
        this.remember(event.id, accepted.map((o) => o.relay));
        console.log(`[nostr] publish: accepted by ${accepted.length} of ${relays.length} relays`);
        return { success: true, platformPostId: event.id, errorMessage: null };
      }

      // No relay said OK. An OK can be lost on the way back while the relay did keep the note, and signing again
      // would make a second, different note, so look for this one by id before giving up.
      const reachable = outcomes.filter((o) => o.reachable).map((o) => o.relay);
      if (reachable.length > 0) {
        const guarded = relays.filter((r) => reachable.includes(r.url));
        const found = await this.readBack(event.id, creds.userPubkey, guarded);
        if (found.confirmedOn.length > 0) {
          this.remember(event.id, found.confirmedOn);
          return { success: true, platformPostId: event.id, errorMessage: null };
        }
      }
      return fail(rejectionCode(outcomes));
    } catch {
      // Deliberately nothing from the error: it could carry text from a relay or the signer.
      return fail("nostr_unexpected_error");
    }
  }

  /** The signer's answer is accepted only when it is the note we asked for. Returns null otherwise. */
  private checkSignedEvent(raw: string, userPubkey: string, content: string): NostrEvent | null {
    if (typeof raw !== "string" || raw.length > MAX_SIGNED_EVENT_CHARS) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const event = asVerifiedEvent(parsed); // structure, id = sha256 of the serialised event, valid Schnorr signature
    if (!event) return null;
    if (event.pubkey !== userPubkey) return null; // signed by someone else
    if (event.kind !== 1 || event.content !== content || event.tags.length !== 0) return null; // not what we sent
    if (getEventHash(event) !== event.id) return null;
    if (Math.abs(event.created_at - Math.floor(this.now() / 1000)) > SIGNED_AT_TOLERANCE_S) return null;
    return event;
  }

  private remember(eventId: string, relays: string[]): void {
    if (this.published.size >= MAX_REMEMBERED_POSTS) {
      const oldest = this.published.keys().next().value;
      if (oldest !== undefined) this.published.delete(oldest);
    }
    this.published.set(eventId, { relays, at: this.now() });
  }

  /** Reads the note back by id over FRESH connections (up to five relays, the ones that accepted it first) and keeps
   *  only an event whose id and signature verify, by the customer's key, with that exact id. */
  private async readBack(eventId: string, userPubkey: string, preferred: GuardedRelay[]): Promise<{ reachable: number; asked: number; confirmedOn: string[] }> {
    const relays = preferred.slice(0, MAX_RELAYS);
    const reads = await Promise.all(relays.map((r) => readFromRelay(this.connect, r, { ids: [eventId] }, this.t.readMs)));
    const confirmedOn = reads.filter((r) => r.events.some((e) => e.id === eventId && e.pubkey === userPubkey && e.kind === 1)).map((r) => r.relay);
    return { reachable: reads.filter((r) => r.reachable).length, asked: relays.length, confirmedOn };
  }

  // Proof of Publish. Never touches post(): the scheduler calls this again on its own until the note is found.
  async verifyPublished(platformPostId: string, accessToken: string): Promise<VerifyResult> {
    const notLive = (errorMessage: string): VerifyResult => ({ verifiedLive: false, platformPostUrl: null, errorMessage });
    if (!isHex64(platformPostId)) return notLive("nostr_unconfirmed: not a Nostr event id");
    const creds = parseCredentials(accessToken);
    if (!creds) return notLive("nostr_bad_connection");
    try {
      const hint = this.published.get(platformPostId);
      const hinted = hint && this.now() - hint.at < REMEMBER_MS ? hint.relays : [];
      const fromList = await this.publishRelays(creds);
      const hintedGuarded = await guardRelays(hinted, MAX_RELAYS);
      const ordered = [...hintedGuarded, ...fromList.filter((r) => !hintedGuarded.some((h) => h.url === r.url))];
      if (ordered.length === 0) return notLive("nostr_unconfirmed: no relay to check");

      // At least two relays are asked whenever two exist. One confirmation is enough, because a returned event is
      // checked end to end (id and signature) and cannot be faked by a relay, but how many agreed is recorded.
      const found = await this.readBack(platformPostId, creds.userPubkey, ordered);
      if (found.confirmedOn.length === 0) {
        console.warn(`[nostr] not confirmed: asked ${found.asked} relays, ${found.reachable} reachable, 0 returned the note`);
        return notLive(found.reachable === 0 ? "nostr_unconfirmed: no relay could be reached to check the note" : "nostr_unconfirmed: the relays did not return the note");
      }
      console.log(`[nostr] confirmed: ${found.confirmedOn.length} of ${found.reachable} reachable relays (${found.asked} asked) returned the verified note`);
      const nevent = nip19.neventEncode({ id: platformPostId, relays: found.confirmedOn.slice(0, 3), author: creds.userPubkey, kind: 1 });
      return { verifiedLive: true, platformPostUrl: `${NOSTR_PROOF_VIEWER}${nevent}`, errorMessage: null };
    } catch {
      return notLive("nostr_unconfirmed: the check could not finish");
    }
  }
}

/** Every string value of a JSON object (one level), for the private key check. Empty when the text is not such JSON. */
function jsonStringValues(code: string): string[] {
  try {
    const v: unknown = JSON.parse(code);
    return v && typeof v === "object" && !Array.isArray(v) ? Object.values(v as Record<string, unknown>).filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Picks one short code for "no relay accepted the note", from what the relays said (codes only, never their text). */
function rejectionCode(outcomes: PublishOutcome[]): string {
  const reachable = outcomes.filter((o) => o.reachable);
  if (reachable.length === 0) return "nostr_relays_unreachable";
  const codes = reachable.map((o) => o.code);
  if (codes.includes("rate-limited")) return "nostr_relay_rejected: rate-limited";
  if (codes.includes("invalid-time")) return "nostr_relay_rejected: invalid-time";
  if (codes.includes("pow")) return "nostr_relay_rejected: pow";
  if (codes.includes("auth-required") || codes.includes("restricted")) return "nostr_relay_rejected: restricted";
  if (codes.includes("blocked")) return "nostr_relay_rejected: blocked";
  if (codes.includes("invalid")) return "nostr_relay_rejected: invalid";
  if (codes.every((c) => c === null)) return "nostr_relay_timeout";
  return "nostr_relay_rejected: other";
}

// Exported for tests and the connect step's own checks.
export { NOSTR_DEFAULT_RELAYS, NOSTR_PROOF_VIEWER, NOSTR_TEXT_LIMIT, NOSTR_TEXT_LIMIT_BYTES };
export { looksLikeSecretKey, PRIVATE_KEY_REFUSED_MESSAGE };
