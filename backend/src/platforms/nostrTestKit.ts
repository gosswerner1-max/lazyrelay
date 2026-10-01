// Test-only: an in-memory Nostr network (fake relays) and a fake NIP-46 signer. Nothing here opens a socket or reaches a
// real relay or signer. The keys are random throwaway test keys generated in memory for each test; no real key exists.

import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { bytesToHex } from "nostr-tools/utils";
import type { RelayConnection, RelayConnector } from "./nostrRelay.js";
import type { GuardedRelay } from "./nostrRelayGuard.js";

type Filter = { ids?: string[]; authors?: string[]; kinds?: number[]; since?: number; until?: number; limit?: number; [tag: string]: unknown };

function matches(f: Filter, e: Event): boolean {
  if (f.ids && !f.ids.includes(e.id)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  for (const key of Object.keys(f)) {
    if (key.startsWith("#")) {
      const wanted = f[key] as string[];
      if (!e.tags.some((t) => t[0] === key.slice(1) && wanted.includes(t[1]))) return false;
    }
  }
  return true;
}

class FakeConn implements RelayConnection {
  closed = false;
  subs = new Map<string, Filter[]>();
  private messageHandlers: Array<(t: string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  constructor(readonly relay: FakeRelay) {}
  send(text: string): void {
    if (this.closed) throw new Error("socket closed");
    setTimeout(() => this.relay.handle(this, text), 0);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.relay.conns.delete(this);
    for (const h of this.closeHandlers) h();
  }
  onMessage(h: (t: string) => void): void {
    this.messageHandlers.push(h);
  }
  onClose(h: () => void): void {
    this.closeHandlers.push(h);
  }
  deliver(msg: unknown[]): void {
    if (this.closed) return;
    const text = JSON.stringify(msg);
    setTimeout(() => {
      if (!this.closed) for (const h of this.messageHandlers) h(text);
    }, 0);
  }
}

export type OkMode = "accept" | { reject: string } | "silent" | "store-but-no-ok";

export class FakeRelay {
  events = new Map<string, Event>();
  conns = new Set<FakeConn>();
  online = true;
  okMode: OkMode = "accept";
  /** REQs by id return nothing (the note did not propagate). */
  hideStored = false;
  /** Rewrites what a REQ returns (a lying relay). */
  rewriteOnRead: ((e: Event) => unknown) | null = null;
  received: unknown[][] = [];
  totalConnections = 0;
  constructor(readonly url: string, private readonly network: FakeNetwork) {}

  /** Events of one kind this relay received (excluding signer traffic). */
  receivedEvents(kind: number): Event[] {
    return this.received.filter((m) => m[0] === "EVENT" && (m[1] as Event).kind === kind).map((m) => m[1] as Event);
  }

  handle(conn: FakeConn, text: string): void {
    let msg: unknown[];
    try {
      msg = JSON.parse(text) as unknown[];
    } catch {
      return;
    }
    this.received.push(msg);
    if (msg[0] === "EVENT") {
      const ev = msg[1] as Event;
      if (this.okMode === "silent") return;
      if (typeof this.okMode === "object") {
        conn.deliver(["OK", ev.id, false, this.okMode.reject]);
        return;
      }
      const ephemeral = ev.kind >= 20000 && ev.kind < 30000;
      if (!ephemeral) this.events.set(ev.id, ev);
      if (this.okMode === "accept") conn.deliver(["OK", ev.id, true, ""]);
      this.inject(ev);
      this.network.notifySigners(this, ev);
    } else if (msg[0] === "REQ") {
      const subId = msg[1] as string;
      const filters = msg.slice(2) as Filter[];
      conn.subs.set(subId, filters);
      if (!this.hideStored) {
        for (const f of filters) {
          const found = [...this.events.values()].filter((e) => matches(f, e)).sort((a, b) => b.created_at - a.created_at).slice(0, f.limit ?? 100);
          for (const e of found) conn.deliver(["EVENT", subId, this.rewriteOnRead ? this.rewriteOnRead(e) : e]);
        }
      }
      conn.deliver(["EOSE", subId]);
    } else if (msg[0] === "CLOSE") {
      conn.subs.delete(msg[1] as string);
    }
  }

  /** Pushes an event to every live subscription that matches it (also how a signer's answer arrives). */
  inject(ev: Event): void {
    for (const c of this.conns) {
      for (const [subId, filters] of c.subs) if (filters.some((f) => matches(f, ev))) c.deliver(["EVENT", subId, ev]);
    }
  }
}

export class FakeNetwork {
  relays = new Map<string, FakeRelay>();
  signers: FakeSigner[] = [];
  /** Every URL a socket was opened to, in order. */
  connectLog: string[] = [];

  add(url: string): FakeRelay {
    const r = new FakeRelay(url, this);
    this.relays.set(url, r);
    return r;
  }

  get connector(): RelayConnector {
    return async (relay: GuardedRelay) => {
      this.connectLog.push(relay.url);
      const r = this.relays.get(relay.url);
      if (!r || !r.online) throw new Error("unreachable");
      r.totalConnections += 1;
      const c = new FakeConn(r);
      r.conns.add(c);
      return c;
    };
  }

  /** Sockets still open: a post must leave none behind. */
  openConnections(): number {
    return [...this.relays.values()].reduce((n, r) => n + r.conns.size, 0);
  }

  notifySigners(relay: FakeRelay, ev: Event): void {
    for (const s of this.signers) s.onRequest(relay, ev);
  }
}

export type SignerMode = "normal" | "offline" | "refuse" | "revoked" | "auth_url" | "garbage";
export type Tamper = null | "content" | "sig" | "id" | "otherKey" | "resignedOtherContent" | "extraTags" | "stale" | "notJson";

export class FakeSigner {
  readonly signerSk = generateSecretKey();
  readonly signerPk = getPublicKey(this.signerSk);
  readonly userSk = generateSecretKey();
  readonly userPk = getPublicKey(this.userSk);
  readonly userSkHex = bytesToHex(this.userSk);
  mode: SignerMode = "normal";
  tamper: Tamper = null;
  expectSecret: string | null = null;
  /** What connect answers instead of "ack" or the secret (a signer that gets it wrong). */
  connectResultOverride: string | null = null;
  switchRelays: string[] | null = null;
  calls: Array<{ method: string; params: string[] }> = [];
  private pending: Array<() => void> = [];

  constructor(network: FakeNetwork) {
    network.signers.push(this);
  }

  bunkerUrl(relays: string[], secret?: string): string {
    const q = relays.map((r) => `relay=${encodeURIComponent(r)}`);
    if (secret) q.push(`secret=${encodeURIComponent(secret)}`);
    return `bunker://${this.signerPk}?${q.join("&")}`;
  }

  /** The person taps Approve: answers requests held back by the auth challenge. */
  approve(): void {
    const p = this.pending;
    this.pending = [];
    for (const f of p) f();
  }

  private respond(relay: FakeRelay, clientPk: string, body: { id: string; result?: string; error?: string }): void {
    const ck = nip44.getConversationKey(this.signerSk, clientPk);
    const ev = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [["p", clientPk]], content: nip44.encrypt(JSON.stringify(body), ck) }, this.signerSk);
    relay.inject(ev);
  }

  onRequest(relay: FakeRelay, ev: Event): void {
    if (ev.kind !== 24133 || !ev.tags.some((t) => t[0] === "p" && t[1] === this.signerPk) || this.mode === "offline") return;
    let req: { id: string; method: string; params: string[] };
    try {
      req = JSON.parse(nip44.decrypt(ev.content, nip44.getConversationKey(this.signerSk, ev.pubkey)));
    } catch {
      return;
    }
    this.calls.push({ method: req.method, params: req.params });
    const answer = () => this.respond(relay, ev.pubkey, { id: req.id, ...this.answerFor(req.method, req.params) });
    if (this.mode === "auth_url") {
      this.respond(relay, ev.pubkey, { id: req.id, result: "auth_url", error: "https://signer.example.com/approve?session=abc" });
      this.pending.push(answer);
      return;
    }
    answer();
  }

  private answerFor(method: string, params: string[]): { result?: string; error?: string } {
    if (this.mode === "refuse") return { error: "user denied the request" };
    if (this.mode === "revoked") return { error: "unauthorized: no such session" };
    if (this.mode === "garbage") return { result: undefined };
    switch (method) {
      case "connect":
        if (this.expectSecret && params[1] !== this.expectSecret) return { error: "invalid secret" };
        if (this.connectResultOverride !== null) return { result: this.connectResultOverride };
        return { result: params[1] ? params[1] : "ack" };
      case "get_public_key":
        return { result: this.userPk };
      case "switch_relays":
        return { result: this.switchRelays ? JSON.stringify(this.switchRelays) : "null" };
      case "sign_event":
        return this.sign(params[0]);
      default:
        return { error: "unknown method" };
    }
  }

  private sign(raw: string): { result: string } {
    const t = JSON.parse(raw) as { kind: number; content: string; tags: string[][]; created_at: number };
    let ev: Event;
    switch (this.tamper) {
      case "otherKey":
        ev = finalizeEvent(t, generateSecretKey());
        break;
      case "resignedOtherContent":
        ev = finalizeEvent({ ...t, content: `${t.content} (edited by the signer)` }, this.userSk);
        break;
      case "extraTags":
        ev = finalizeEvent({ ...t, tags: [["client", "something"]] }, this.userSk);
        break;
      case "stale":
        ev = finalizeEvent({ ...t, created_at: t.created_at - 3 * 3600 }, this.userSk);
        break;
      default:
        ev = finalizeEvent(t, this.userSk);
    }
    if (this.tamper === "content") ev = { ...ev, content: `${ev.content} tampered` };
    if (this.tamper === "sig") ev = { ...ev, sig: ev.sig.replace(/^./, ev.sig[0] === "a" ? "b" : "a") };
    if (this.tamper === "id") ev = { ...ev, id: ev.id.replace(/^./, ev.id[0] === "a" ? "b" : "a") };
    return { result: this.tamper === "notJson" ? "this is not json" : JSON.stringify(ev) };
  }

  /** Signs any template with the user's key (used to build relay lists and forged traffic in tests). */
  signAsUser(template: { kind: number; content: string; tags: string[][]; created_at: number }): Event {
    return finalizeEvent(template, this.userSk);
  }
}
