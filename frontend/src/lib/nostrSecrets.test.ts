import { describe, it, expect } from "vitest";
import { looksLikeNostrSecret, NOSTR_SECRET_MESSAGE } from "./nostrSecrets";

// Throwaway values built from characters, not real keys.
const NSEC = `nsec1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(2).slice(0, 58)}`;
const HEX = "ab".repeat(32);
const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const SIGNER = "c".repeat(64);

describe("looksLikeNostrSecret", () => {
  it("catches an nsec, an ncryptsec, a bare hex secret and a recovery phrase, however they are wrapped", () => {
    for (const v of [NSEC, NSEC.toUpperCase(), `  ${NSEC}  `, `nostr:${NSEC}`, `ncryptsec1${"q".repeat(40)}`, HEX, HEX.toUpperCase(), `0x${HEX}`, PHRASE]) {
      expect(looksLikeNostrSecret(v), v).toBe(true);
    }
  });

  it("catches an nsec hidden inside a bunker link", () => {
    expect(looksLikeNostrSecret(`bunker://${SIGNER}?relay=wss://relay.example.org&secret=${NSEC}`)).toBe(true);
  });

  it("lets a normal bunker link through, even when its secret is 64 hex characters", () => {
    expect(looksLikeNostrSecret(`bunker://${SIGNER}?relay=wss://relay.example.org&secret=abc123`)).toBe(false);
    expect(looksLikeNostrSecret(`bunker://${SIGNER}?relay=wss://relay.example.org&secret=${HEX}`)).toBe(false);
    expect(looksLikeNostrSecret("")).toBe(false);
    expect(looksLikeNostrSecret("a short sentence")).toBe(false);
  });

  it("the message is plain and has no long dashes", () => {
    expect(NOSTR_SECRET_MESSAGE).toMatch(/never accepts one/);
    expect(NOSTR_SECRET_MESSAGE).not.toMatch(/[–—]/);
  });
});
