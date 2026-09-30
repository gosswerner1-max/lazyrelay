import { describe, it, expect } from "vitest";
import { describePlatformLimit, isPlatformLimitDetail } from "./platformLimit";

const fmtT = (iso: string) => `T(${iso.slice(0, 10)})`;
const fmtD = (iso: string) => `D(${iso.slice(0, 10)})`;

// En-dash and em-dash, built from code points so no literal dash sits in this file.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

describe("isPlatformLimitDetail", () => {
  it("recognises the server's 422 body and nothing else", () => {
    expect(isPlatformLimitDetail({ code: "platform_daily_limit", platform: "pinterest", limit: 10, nextAvailable: "2026-10-02T08:00:00Z" })).toBe(true);
    expect(isPlatformLimitDetail({ code: "other", platform: "pinterest", limit: 10, nextAvailable: "x" })).toBe(false);
    expect(isPlatformLimitDetail({ error: "boom" })).toBe(false);
    expect(isPlatformLimitDetail(null)).toBe(false);
  });
});

describe("describePlatformLimit: Pinterest", () => {
  it("the normal cap explains WHY (spam and blocking), the number, and the next free time", () => {
    const r = describePlatformLimit({ platform: "pinterest", limit: 10, nextAvailable: "2026-10-02T08:00:00Z" }, fmtT, fmtD);
    expect(r.title).toBe("Pinterest daily limit reached");
    const text = r.paragraphs.join(" ");
    expect(text).toMatch(/wasn't scheduled/);
    expect(text).toMatch(/up to 10 pins a day/);
    expect(text).toMatch(/treats a lot of pins from one account as spam, and can block the account or your website/);
    expect(text).toMatch(/next free time is T\(2026-10-02\)/);
    expect(text).toMatch(/start slowly and vary your captions/i);
  });

  it("a warming-up account says so, gives the ramp, when it rises, and how to skip it", () => {
    const r = describePlatformLimit(
      { platform: "pinterest", limit: 1, fullLimit: 10, warmingUp: true, warmupEndsAt: "2026-10-15T08:00:00Z", nextAvailable: "2026-10-02T08:00:00Z" },
      fmtT,
      fmtD,
    );
    expect(r.title).toBe("This Pinterest account is still warming up");
    const text = r.paragraphs.join(" ");
    expect(text).toMatch(/allows 1 pin a day/);
    expect(text).toMatch(/1 a day the first week, then 2, then 3/);
    expect(text).toMatch(/up to 10 a day from D\(2026-10-15\)/);
    expect(text).toMatch(/tick "already warmed up"/);
  });

  it("never suggests working around Pinterest, and has no en or em dashes", () => {
    for (const warmingUp of [false, true]) {
      const text = describePlatformLimit(
        { platform: "pinterest", limit: 2, fullLimit: 10, warmingUp, warmupEndsAt: "2026-10-15T08:00:00Z", nextAvailable: "2026-10-02T08:00:00Z" },
        fmtT,
        fmtD,
      ).paragraphs.join(" ");
      expect(text).not.toMatch(DASHES);
      expect(text).not.toMatch(/shortener|redirect|another domain|different (link|domain)/i);
    }
  });
});

describe("describePlatformLimit: other platforms", () => {
  it("falls back to a plain reason", () => {
    const r = describePlatformLimit({ platform: "tiktok", limit: 5, nextAvailable: "2026-10-02T08:00:00Z" }, fmtT, fmtD);
    expect(r.title).toBe("Tiktok daily limit reached");
    expect(r.paragraphs.join(" ")).toMatch(/up to 5 posts a day/);
  });
});
