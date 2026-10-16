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

describe("findProductionConfigProblems: WhatsApp broadcast contacts", () => {
  const ENC = Buffer.alloc(32, 7).toString("base64");
  const READY = { ...GOOD, WHATSAPP_BROADCASTS_ENABLED: "true", WHATSAPP_CONTACT_HASH_KEY: "h".repeat(32), WHATSAPP_CONTACT_ENC_KEY: ENC, WHATSAPP_CONTACT_ENC_KEY_ID: "k1" };

  it("says nothing while the feature is off, whatever is missing", () => {
    expect(findProductionConfigProblems({ ...GOOD })).toEqual([]);
    expect(findProductionConfigProblems({ ...GOOD, WHATSAPP_BROADCASTS_ENABLED: "false" })).toEqual([]);
  });

  it("is quiet when the feature is on and both secrets are usable", () => {
    expect(findProductionConfigProblems(READY)).toEqual([]);
  });

  it("flags a feature that is on without its secrets, naming them but never a value", () => {
    const { WHATSAPP_CONTACT_ENC_KEY: _a, ...noEnc } = READY;
    const p = findProductionConfigProblems(noEnc);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/WHATSAPP_BROADCASTS_ENABLED/);
    expect(p[0]).toMatch(/WHATSAPP_CONTACT_ENC_KEY/);
    const { WHATSAPP_CONTACT_ENC_KEY_ID: _b, ...noId } = READY;
    expect(findProductionConfigProblems(noId)[0]).toMatch(/WHATSAPP_CONTACT_ENC_KEY_ID/);
    const { WHATSAPP_CONTACT_HASH_KEY: _c, ...noHash } = READY;
    expect(findProductionConfigProblems(noHash)[0]).toMatch(/WHATSAPP_CONTACT_HASH_KEY/);
    expect(findProductionConfigProblems({ ...READY, WHATSAPP_CONTACT_ENC_KEY: "short" })[0]).toMatch(/32 bytes/);
    for (const text of [p[0], findProductionConfigProblems({ ...READY, WHATSAPP_CONTACT_ENC_KEY: "short" })[0]]) expect(text).not.toMatch(new RegExp(`${ENC}|short|h{32}`));
  });
});

describe("WHATSAPP_SEND_ENABLED (broadcast and chat sending)", () => {
  const base = { FRONTEND_URL: "https://lazyrelay.com" };
  const keys = { WHATSAPP_CONTACT_HASH_KEY: "h".repeat(40), WHATSAPP_CONTACT_ENC_KEY: Buffer.alloc(32, 1).toString("base64"), WHATSAPP_CONTACT_ENC_KEY_ID: "k1" };

  it("says nothing while it is off", () => {
    expect(findProductionConfigProblems({ ...base })).toEqual([]);
    expect(findProductionConfigProblems({ ...base, WHATSAPP_SEND_ENABLED: "false" })).toEqual([]);
  });

  it("flags sending switched on without the feature switches, naming only the settings", () => {
    const problems = findProductionConfigProblems({ ...base, WHATSAPP_SEND_ENABLED: "true" });
    expect(problems.join(" ")).toMatch(/WHATSAPP_SEND_ENABLED/);
    expect(problems.join(" ")).toMatch(/WHATSAPP_BYOK_ENABLED/);
    expect(problems.join(" ")).toMatch(/WHATSAPP_BROADCASTS_ENABLED/);
  });

  it("flags sending without the webhook verify token (receipts and replies could never arrive)", () => {
    const problems = findProductionConfigProblems({ ...base, ...keys, WHATSAPP_BYOK_ENABLED: "true", WHATSAPP_BROADCASTS_ENABLED: "true", WHATSAPP_SEND_ENABLED: "true" });
    expect(problems.join(" ")).toMatch(/WHATSAPP_WEBHOOK_VERIFY_TOKEN/);
  });

  it("is quiet when everything it needs is set, and never prints a value", () => {
    const env = { ...base, ...keys, WHATSAPP_BYOK_ENABLED: "true", WHATSAPP_BROADCASTS_ENABLED: "true", WHATSAPP_SEND_ENABLED: "true", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "some-verify-token-value" };
    expect(findProductionConfigProblems(env)).toEqual([]);
    expect(findProductionConfigProblems({ ...env, WHATSAPP_WEBHOOK_VERIFY_TOKEN: undefined }).join(" ")).not.toMatch(/some-verify-token-value|hhhhhh/);
  });
});
