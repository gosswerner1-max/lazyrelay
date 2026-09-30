import { describe, it, expect } from "vitest";
import { findProductionConfigProblems } from "./startupConfigCheck.js";

const GOOD = {
  FRONTEND_URL: "https://lazyrelay.com",
  TIKTOK_CLIENT_KEY: "aw9abcdefghijklm",
  BLUESKY_CONNECT_PAGE_URL: "https://lazyrelay.com/connect/bluesky",
  TELEGRAM_CONNECT_PAGE_URL: "https://lazyrelay.com/connect/telegram",
  DISCORD_CONNECT_PAGE_URL: "https://lazyrelay.com/connect/discord",
};

describe("findProductionConfigProblems", () => {
  it("a correct production environment has no problems", () => {
    expect(findProductionConfigProblems(GOOD)).toEqual([]);
  });

  it("flags a missing FRONTEND_URL", () => {
    const { FRONTEND_URL: _drop, ...env } = GOOD;
    const p = findProductionConfigProblems(env);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/FRONTEND_URL is not set/);
  });

  it("flags the TikTok Sandbox key (the 2026-09-29 incident)", () => {
    const p = findProductionConfigProblems({ ...GOOD, TIKTOK_CLIENT_KEY: "sbawxxxxxxxxxxxx" });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/Sandbox app key/);
  });

  it("flags the three connect-page URLs left pointing at localhost (the 2026-09-29 restore), naming them but never their values", () => {
    const p = findProductionConfigProblems({
      ...GOOD,
      BLUESKY_CONNECT_PAGE_URL: "http://localhost:5173/connect/bluesky",
      TELEGRAM_CONNECT_PAGE_URL: "http://localhost:5173/connect/telegram",
      DISCORD_CONNECT_PAGE_URL: "http://localhost:5173/connect/discord",
    });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/BLUESKY_CONNECT_PAGE_URL, DISCORD_CONNECT_PAGE_URL, TELEGRAM_CONNECT_PAGE_URL/);
    expect(p[0]).not.toMatch(/5173\/connect/);
  });

  it("catches any URL-like setting pointing at this machine, in any spelling", () => {
    const p = findProductionConfigProblems({
      ...GOOD,
      TIKTOK_REDIRECT_URI: "http://127.0.0.1:3000/api/social-accounts/callback",
      PUBLIC_SITE_URL: "http://LOCALHOST/",
      SOME_ORIGIN: "http://[::1]:8080",
    });
    expect(p[0]).toMatch(/PUBLIC_SITE_URL, SOME_ORIGIN, TIKTOK_REDIRECT_URI/);
  });

  it("does not flag real URLs, non-URL settings, or a hostname that merely contains 'localhost'", () => {
    expect(
      findProductionConfigProblems({
        ...GOOD,
        SUPABASE_URL: "https://abc.supabase.co",
        NOTE_TEXT: "http://localhost is where dev runs",
        PUBLIC_SITE_URL: "https://localhost-tools.example.org",
      }),
    ).toEqual([]);
  });

  it("reports each kind of problem separately", () => {
    const p = findProductionConfigProblems({ TIKTOK_CLIENT_KEY: "sbxx", BLUESKY_CONNECT_PAGE_URL: "http://localhost:5173/x" });
    expect(p).toHaveLength(3);
  });
});
