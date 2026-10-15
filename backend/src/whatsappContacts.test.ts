// Pure helpers of the WhatsApp contacts service: the consent-evidence hash chain, consent date parsing, the affirmative
// "opted_in" cell, and name cleaning. The database-touching functions are exercised through the routes test.

import { describe, it, expect, vi } from "vitest";
vi.mock("./supabase.js", () => ({ supabase: {} }));
import type { OptInHashFields } from "./whatsappContacts.js";
const { computeOptInRowHash, verifyOptInChain, GENESIS_HASH, parseConsentDate, isAffirmative, cleanDisplayName } = await import("./whatsappContacts.js");

const base: OptInHashFields = {
  prevHash: GENESIS_HASH,
  accountId: "11111111-1111-4111-8111-111111111111",
  contactId: "22222222-2222-4222-8222-222222222222",
  source: "website_form",
  capturedAt: "2026-10-01T00:00:00.000Z",
  recordedAt: "2026-10-15T10:00:00.000Z",
  recordedBy: "33333333-3333-4333-8333-333333333333",
  consentText: "I agree to get offers on WhatsApp",
  proofReference: "form-submission-991",
  attested: true,
  attestationVersion: "2026-10-15.1",
  importBatchId: null,
};

describe("computeOptInRowHash", () => {
  it("is a stable 64 hex string", () => {
    expect(computeOptInRowHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeOptInRowHash(base)).toBe(computeOptInRowHash({ ...base }));
    expect(GENESIS_HASH).toBe("0".repeat(64));
  });

  it.each([
    ["prevHash", "1".repeat(64)],
    ["accountId", "99999999-9999-4999-8999-999999999999"],
    ["contactId", "99999999-9999-4999-8999-999999999999"],
    ["source", "in_person"],
    ["capturedAt", "2026-10-02T00:00:00.000Z"],
    ["recordedAt", "2026-10-15T10:00:01.000Z"],
    ["recordedBy", null],
    ["consentText", "I agree to get offers on WhatsApp!"],
    ["proofReference", null],
    ["attestationVersion", "2026-10-16.1"],
    ["importBatchId", "44444444-4444-4444-8444-444444444444"],
  ])("changes when %s changes", (field, value) => {
    expect(computeOptInRowHash({ ...base, [field]: value } as OptInHashFields)).not.toBe(computeOptInRowHash(base));
  });

  it("cannot be confused by moving text between adjacent fields", () => {
    const a = computeOptInRowHash({ ...base, consentText: "ab", proofReference: "c" });
    const b = computeOptInRowHash({ ...base, consentText: "a", proofReference: "bc" });
    expect(a).not.toBe(b);
  });
});

describe("verifyOptInChain", () => {
  const chain = () => {
    const first = { ...base, rowHash: computeOptInRowHash(base) };
    const secondFields = { ...base, prevHash: first.rowHash, recordedAt: "2026-10-16T10:00:00.000Z" };
    return [first, { ...secondFields, rowHash: computeOptInRowHash(secondFields) }];
  };

  it("accepts an intact chain", () => {
    expect(verifyOptInChain(chain())).toEqual({ ok: true });
  });

  it("detects an edited row and a removed first row", () => {
    const edited = chain();
    edited[0] = { ...edited[0], consentText: "changed" };
    expect(verifyOptInChain(edited)).toEqual({ ok: false, brokenAt: 0 });
    expect(verifyOptInChain(chain().slice(1))).toEqual({ ok: false, brokenAt: 0 });
  });
});

describe("parseConsentDate", () => {
  it("reads a date or an ISO time and rejects junk", () => {
    expect(parseConsentDate("2026-10-01")?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(parseConsentDate("2026-10-01T08:30:00Z")?.toISOString()).toBe("2026-10-01T08:30:00.000Z");
    expect(parseConsentDate("01/10/2026")).toBeNull();
    expect(parseConsentDate("2026-13-45")).toBeNull();
    expect(parseConsentDate("")).toBeNull();
    expect(parseConsentDate(5 as unknown as string)).toBeNull();
  });
});

describe("isAffirmative", () => {
  it("accepts clear yes values only", () => {
    for (const v of ["yes", "Y", "TRUE", "true", "1", "opted_in", "Opted In", "opt-in", true, 1]) expect(isAffirmative(v)).toBe(true);
    for (const v of ["", "no", "n", "false", "0", "maybe", "unknown", "opted_out", null, undefined, false, 0, {}]) expect(isAffirmative(v)).toBe(false);
  });
});

describe("cleanDisplayName", () => {
  it("trims, removes control characters, and flags names that are too long", () => {
    expect(cleanDisplayName("  Thandi\u0000 Nkosi ")).toEqual({ ok: true, value: "Thandi Nkosi" });
    expect(cleanDisplayName("")).toEqual({ ok: true, value: null });
    expect(cleanDisplayName(undefined)).toEqual({ ok: true, value: null });
    expect(cleanDisplayName("x".repeat(81))).toEqual({ ok: false });
    expect(cleanDisplayName("Call 082 123 4567")).toEqual({ ok: false });
    expect(cleanDisplayName(5 as unknown as string)).toEqual({ ok: false });
  });
});
