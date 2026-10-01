// NIP-46 client behaviour against a fake signer on an in-memory relay network: token parsing, the private key refusal,
// request/response binding, auth challenges, refusals. No sockets, no real relay, no real key.

import { describe, it, expect, beforeEach } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import * as nip44 from "nostr-tools/nip44";
import { bytesToHex } from "nostr-tools/utils";
import { FakeNetwork, FakeSigner } from "./nostrTestKit.js";
import { SignerChannel, SignerError, looksLikeSecretKey, parseBunkerToken, PRIVATE_KEY_REFUSED_MESSAGE, REQUESTED_PERMISSIONS } from "./nostrSigner.js";

const RELAY = "wss://relay-a.example.org";
const guarded = (url: string) => ({ url, host: new URL(url).hostname, addresses: ["93.184.216.34"] });

describe("looksLikeSecretKey / parseBunkerToken", () => {
  const nsec = nip19.nsecEncode(generateSecretKey()); // a throwaway random test key
  const hex64 = bytesToHex(generateSecretKey());
  const signerPk = getPublicKey(generateSecretKey());
  const good = `bunker://${signerPk}?relay=wss%3A%2F%2Frelay-a.example.org&relay=wss%3A%2F%2Frelay-b.example.org&secret=abc123`;

  it("accepts a normal bunker link and extracts signer key, relays and secret", () => {
    const r = parseBunkerToken(good);
    expect(r).toEqual({ ok: true, token: { signerPubkey: signerPk, relays: ["wss://relay-a.example.org", "wss://relay-b.example.org"], secret: "abc123" } });
  });

  it("accepts a link with no secret, upper case hex, a slash before the query, and surrounding spaces", () => {
    expect(parseBunkerToken(`  bunker://${signerPk.toUpperCase()}/?relay=wss://relay-a.example.org  `)).toMatchObject({ ok: true, token: { signerPubkey: signerPk, secret: null } });
  });

  it("accepts a secret that is itself 64 hex characters (some signers make them that way)", () => {
    expect(parseBunkerToken(`bunker://${signerPk}?relay=wss://relay-a.example.org&secret=${hex64}`)).toMatchObject({ ok: true, token: { secret: hex64 } });
  });

  it("refuses an nsec, a bare 64 hex secret, an ncryptsec and a recovery phrase, with the same plain message", () => {
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const ncrypt = `ncryptsec1${"q".repeat(40)}`;
    for (const input of [nsec, nsec.toUpperCase(), `  ${nsec}  `, hex64, hex64.toUpperCase(), `0x${hex64}`, phrase, ncrypt, `nostr:${nsec}`]) {
      expect(looksLikeSecretKey(input), input).toBe(true);
      const r = parseBunkerToken(input);
      expect(r).toEqual({ ok: false, error: PRIVATE_KEY_REFUSED_MESSAGE });
    }
  });

  it("refuses an nsec hidden inside an otherwise valid bunker link", () => {
    const r = parseBunkerToken(`${good}&extra=${nsec}`);
    expect(r).toEqual({ ok: false, error: PRIVATE_KEY_REFUSED_MESSAGE });
  });

  it("never mistakes a normal bunker link or a public key for a private key", () => {
    expect(looksLikeSecretKey(good)).toBe(false);
    expect(looksLikeSecretKey("just a short sentence here")).toBe(false);
    expect(looksLikeSecretKey(nip19.npubEncode(signerPk))).toBe(false);
  });

  it("refuses bad schemes, wrong shapes and missing or unusable relays, in plain words that never repeat the input", () => {
    const cases = [
      "", "   ", "hello", "https://example.org", `bunker:${signerPk}?relay=wss://relay-a.example.org`, `nostr+walletconnect://${signerPk}?relay=wss://relay-a.example.org`,
      `bunker://${signerPk.slice(0, 60)}?relay=wss://relay-a.example.org`, `bunker://${signerPk}`, `bunker://${signerPk}?secret=x`,
      `bunker://${signerPk}?relay=ws://relay-a.example.org`, `bunker://${signerPk}?relay=wss://127.0.0.1`, `bunker://${signerPk}?relay=wss://localhost&relay=wss://10.0.0.1`,
      `nostrconnect://${signerPk}?relay=wss://relay-a.example.org&secret=s`, `bunker://${"z".repeat(64)}?relay=wss://relay-a.example.org`,
      `bunker://${signerPk}?relay=wss://relay-a.example.org&secret=${"x".repeat(600)}`, `bunker://${signerPk}?relay=wss://relay-a.example.org${"a".repeat(2100)}`,
    ];
    for (const input of cases) {
      const r = parseBunkerToken(input);
      expect(r.ok, input).toBe(false);
      if (!r.ok) {
        expect(r.error.length).toBeGreaterThan(10);
        expect(r.error).not.toContain(signerPk);
        expect(r.error).not.toMatch(/[–—]/);
      }
    }
    expect(parseBunkerToken(undefined as never).ok).toBe(false);
    expect(parseBunkerToken(42 as never).ok).toBe(false);
  });

  it("drops unusable relays from a mixed list but keeps the good one", () => {
    const r = parseBunkerToken(`bunker://${signerPk}?relay=ws://x.example.org&relay=wss://relay-a.example.org&relay=wss://192.168.0.1`);
    expect(r).toMatchObject({ ok: true, token: { relays: ["wss://relay-a.example.org"] } });
  });
});

describe("SignerChannel", () => {
  let net: FakeNetwork;
  let relay: ReturnType<FakeNetwork["add"]>;
  let signer: FakeSigner;
  let clientSk: Uint8Array;
  const channel = (relays = [RELAY]) => new SignerChannel({ connect: net.connector, clientSecretKey: clientSk, signerPubkey: signer.signerPk, relays: relays.map(guarded) });

  beforeEach(() => {
    net = new FakeNetwork();
    relay = net.add(RELAY);
    signer = new FakeSigner(net);
    clientSk = generateSecretKey();
  });

  it("connect, get_public_key and sign_event work end to end, and every socket is closed afterwards", async () => {
    const c = channel();
    expect(await c.request("connect", [signer.signerPk, "", REQUESTED_PERMISSIONS], { timeoutMs: 1000 })).toBe("ack");
    expect(await c.request("get_public_key", [], { timeoutMs: 1000 })).toBe(signer.userPk);
    const template = { kind: 1, content: "hello", tags: [], created_at: Math.floor(Date.now() / 1000) };
    const signed = JSON.parse(await c.request("sign_event", [JSON.stringify(template)], { timeoutMs: 1000 }));
    expect(signed).toMatchObject({ kind: 1, content: "hello", pubkey: signer.userPk });
    expect(net.openConnections()).toBe(0);
  });

  it("sends the request as an encrypted kind 24133 from the disposable key, after subscribing for the answer", async () => {
    await channel().request("get_public_key", [], { timeoutMs: 1000 });
    const kinds = relay.received.map((m) => m[0]);
    expect(kinds.indexOf("REQ")).toBeLessThan(kinds.indexOf("EVENT")); // subscribe first, the answer is ephemeral
    const req = relay.receivedEvents(24133)[0];
    expect(req.pubkey).toBe(getPublicKey(clientSk));
    expect(req.pubkey).not.toBe(signer.userPk);
    expect(req.tags).toContainEqual(["p", signer.signerPk]);
    expect(req.content).not.toContain("get_public_key"); // encrypted, not plain JSON
    const filter = relay.received.find((m) => m[0] === "REQ")![2] as Record<string, unknown>;
    expect(filter).toMatchObject({ kinds: [24133], authors: [signer.signerPk], "#p": [getPublicKey(clientSk)] });
  });

  it("requests only the permissions it needs", () => {
    expect(REQUESTED_PERMISSIONS).toBe("sign_event:1,get_public_key");
  });

  it("a refused request, a removed connection and a nonsense answer each become a distinct code", async () => {
    signer.mode = "refuse";
    await expect(channel().request("sign_event", ["{}"], { timeoutMs: 500 })).rejects.toMatchObject({ failure: "refused", message: "nostr_signer_refused" });
    signer.mode = "revoked";
    await expect(channel().request("sign_event", ["{}"], { timeoutMs: 500 })).rejects.toMatchObject({ failure: "revoked" });
    signer.mode = "garbage";
    await expect(channel().request("sign_event", ["{}"], { timeoutMs: 500 })).rejects.toMatchObject({ failure: "protocol" });
    expect(net.openConnections()).toBe(0);
  });

  it("an auth challenge fails at once when nobody can approve (a scheduled post)", async () => {
    signer.mode = "auth_url";
    const started = Date.now();
    const err = await channel().request("sign_event", ["{}"], { timeoutMs: 5000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignerError);
    expect((err as SignerError).failure).toBe("auth_url");
    expect((err as SignerError).authHost).toBe("signer.example.com"); // host only, never the full URL
    expect((err as SignerError).message).not.toContain("approve?session");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("an auth challenge keeps waiting for the real answer under the same request id when a person can approve", async () => {
    signer.mode = "auth_url";
    const pending = channel().request("get_public_key", [], { timeoutMs: 2000, authWaitMs: 2000 });
    setTimeout(() => signer.approve(), 50);
    expect(await pending).toBe(signer.userPk);
  });

  it("an auth challenge nobody approves ends as auth_url, not as a hang", async () => {
    signer.mode = "auth_url";
    await expect(channel().request("get_public_key", [], { timeoutMs: 2000, authWaitMs: 100 })).rejects.toMatchObject({ failure: "auth_url" });
  });

  it("a signer that never answers is a timeout; relays that cannot be opened are unreachable", async () => {
    signer.mode = "offline";
    await expect(channel().request("get_public_key", [], { timeoutMs: 150 })).rejects.toMatchObject({ failure: "timeout" });
    relay.online = false;
    await expect(channel().request("get_public_key", [], { timeoutMs: 150 })).rejects.toMatchObject({ failure: "unreachable" });
  });

  it("relays that all reject the request event count as unreachable, not as a hang", async () => {
    relay.okMode = { reject: "restricted: not allowed to write" };
    await expect(channel().request("get_public_key", [], { timeoutMs: 1500 })).rejects.toMatchObject({ failure: "unreachable" });
  });

  describe("request/response binding", () => {
    async function withForgery(forge: (req: { id: string; clientPk: string }) => void) {
      signer.mode = "offline"; // the real signer stays silent so only forged traffic can answer
      const pending = channel().request("get_public_key", [], { timeoutMs: 400 });
      await new Promise((r) => setTimeout(r, 40));
      const reqEvent = relay.receivedEvents(24133)[0];
      const req = JSON.parse(nip44.decrypt(reqEvent.content, nip44.getConversationKey(signer.signerSk, reqEvent.pubkey)));
      forge({ id: req.id, clientPk: reqEvent.pubkey });
      return pending;
    }
    const answer = (signerSk: Uint8Array, clientPk: string, body: object, tags?: string[][]) =>
      finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: tags ?? [["p", clientPk]], content: nip44.encrypt(JSON.stringify(body), nip44.getConversationKey(signerSk, clientPk)) }, signerSk);

    it("ignores an answer that is not signed by the stored signer, even with the right request id", async () => {
      const attacker = generateSecretKey();
      const outcome = await withForgery(({ id, clientPk }) => relay.inject(answer(attacker, clientPk, { id, result: getPublicKey(attacker) }))).catch((e: SignerError) => e);
      expect(outcome).toMatchObject({ failure: "timeout" });
    });

    it("ignores an answer for a different request id (a replay of an old answer)", async () => {
      const outcome = await withForgery(({ clientPk }) => relay.inject(answer(signer.signerSk, clientPk, { id: "an-older-request", result: "stale" }))).catch((e: SignerError) => e);
      expect(outcome).toMatchObject({ failure: "timeout" });
    });

    it("ignores an answer that is not addressed to the disposable key", async () => {
      const outcome = await withForgery(({ id, clientPk }) => relay.inject(answer(signer.signerSk, clientPk, { id, result: "x" }, [["p", getPublicKey(generateSecretKey())]]))).catch((e: SignerError) => e);
      expect(outcome).toMatchObject({ failure: "timeout" });
    });

    it("takes the genuine answer: right signer, right key, right id", async () => {
      const outcome = await withForgery(({ id, clientPk }) => relay.inject(answer(signer.signerSk, clientPk, { id, result: "the-real-answer" })));
      expect(outcome).toBe("the-real-answer");
    });

    it("ignores an answer whose signature does not verify", async () => {
      const outcome = await withForgery(({ id, clientPk }) => {
        const ev = answer(signer.signerSk, clientPk, { id, result: "forged" });
        relay.inject({ ...ev, sig: ev.sig.replace(/^./, ev.sig[0] === "a" ? "b" : "a") });
      }).catch((e: SignerError) => e);
      expect(outcome).toMatchObject({ failure: "timeout" });
    });
  });
});
