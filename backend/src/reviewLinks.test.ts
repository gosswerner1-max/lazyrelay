import { describe, it, expect } from "vitest";
import { generateReviewToken, looksLikeReviewToken, cleanName, cleanComment, linkStatus, MAX_REVIEW_COMMENT_LENGTH } from "./reviewLinks.js";

describe("review tokens", () => {
  it("are long, random and URL safe", () => {
    const a = generateReviewToken();
    const b = generateReviewToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(looksLikeReviewToken(a)).toBe(true);
  });
  it("anything that does not look like one is rejected before any lookup", () => {
    for (const bad of ["", "short", "x".repeat(44), "x".repeat(42) + "!", undefined, 5, null]) expect(looksLikeReviewToken(bad)).toBe(false);
  });
});

describe("cleanName and cleanComment", () => {
  it("names are required, trimmed and capped", () => {
    expect(cleanName("  Sam   Client ")).toEqual({ ok: true, name: "Sam Client" });
    expect(cleanName("").ok).toBe(false);
    expect(cleanName(undefined).ok).toBe(false);
    expect(cleanName("x".repeat(61)).ok).toBe(false);
  });
  it("comments can be optional or required, and are capped", () => {
    expect(cleanComment(undefined, false)).toEqual({ ok: true, body: null });
    expect(cleanComment("  ", true).ok).toBe(false);
    expect(cleanComment(" Looks good ", true)).toEqual({ ok: true, body: "Looks good" });
    expect(cleanComment("x".repeat(MAX_REVIEW_COMMENT_LENGTH + 1), false).ok).toBe(false);
    expect(cleanComment(42, false).ok).toBe(false);
  });
});

describe("linkStatus", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  it("revoked wins, then expired, otherwise active", () => {
    expect(linkStatus({ expires_at: "2026-10-30T00:00:00Z", revoked_at: null }, now)).toBe("active");
    expect(linkStatus({ expires_at: "2026-09-01T00:00:00Z", revoked_at: null }, now)).toBe("expired");
    expect(linkStatus({ expires_at: "2026-10-30T00:00:00Z", revoked_at: "2026-09-29T00:00:00Z" }, now)).toBe("revoked");
  });
});
