// Pure helpers for the Link Tracking Engine: the destination allow-list (no open redirect), bot filtering, the per-day visitor hash and code generation.
import { describe, it, expect } from "vitest";
import * as helpers from "./trackedLinks.js";
import { parseDestination, isBotUserAgent, newCode, CODE_RE, HOME_URL } from "./trackedLinks.js";

describe("parseDestination (the only places a tracked link may point)", () => {
  it("accepts https pages on lazyrelay.com and timeajob.com, with or without www, and returns the normalised address", () => {
    expect(parseDestination("https://lazyrelay.com/pricing")).toBe("https://lazyrelay.com/pricing");
    expect(parseDestination("https://www.lazyrelay.com/stuck-on-what-to-post?utm_source=pinterest")).toBe("https://www.lazyrelay.com/stuck-on-what-to-post?utm_source=pinterest");
    expect(parseDestination("https://timeajob.com/guides#top")).toBe("https://timeajob.com/guides#top");
    expect(parseDestination("https://TimeAJob.com")).toBe("https://timeajob.com/");
  });
  it("refuses everything else, including the classic open-redirect tricks", () => {
    for (const bad of [
      "http://lazyrelay.com/pricing",
      "https://evil.com/",
      "https://lazyrelay.com.evil.com/",
      "https://evil.com/?u=lazyrelay.com",
      "https://lazyrelay.com@evil.com/",
      "https://user:pw@lazyrelay.com/",
      "https://lazyrelay.com:8443/",
      "https://lazyrelay.com\\@evil.com/",
      "https://xn--lazyrelay-9ya.com/",
      "https://sub.lazyrelay.com/",
      "https://notlazyrelay.com/",
      "//lazyrelay.com/pricing",
      "javascript:alert(1)",
      "data:text/html,hi",
      "/pricing",
      "",
      "   ",
    ]) {
      expect(parseDestination(bad), bad).toBeNull();
    }
    for (const notString of [undefined, null, 5, {}, ["https://lazyrelay.com/"]]) expect(parseDestination(notString as unknown)).toBeNull();
  });
  it("keeps the trailing-dot, default-port and encoded-dot cases locked", () => {
    expect(parseDestination("https://lazyrelay.com./pricing")).toBeNull();
    expect(parseDestination("https://lazyrelay.com:443/pricing")).toBe("https://lazyrelay.com/pricing"); // the default port is dropped, so the stored address never carries one
    expect(parseDestination("https://lazyrelay.com:8443/pricing")).toBeNull();
    expect(parseDestination("https://lazyrelay%2ecom/pricing")).toBe("https://lazyrelay.com/pricing");
  });
  it("refuses an address over 2048 characters", () => {
    expect(parseDestination("https://lazyrelay.com/" + "a".repeat(2100))).toBeNull();
  });
});

describe("isBotUserAgent", () => {
  it("flags link-preview and crawler agents so they never inflate the numbers", () => {
    for (const ua of ["facebookexternalhit/1.1", "Twitterbot/1.0", "Slackbot-LinkExpanding 1.0", "Mozilla/5.0 (compatible; Googlebot/2.1)", "WhatsApp/2.23.1", "TelegramBot (like TwitterBot)", "Mozilla/5.0 (compatible; Discordbot/2.0)", "LinkedInBot/1.0", "Pinterestbot/1.0", "curl/8.0", "python-requests/2.31", "HeadlessChrome/120"]) {
      expect(isBotUserAgent(ua), ua).toBe(true);
    }
  });
  it("also flags the preview fetchers of the networks LazyRelay posts to", () => {
    for (const ua of ["http.rb/5.1.1 (Mastodon/4.2.0; +https://mastodon.social/)", "Bluesky Cardyb/1.1", "Lemmy/0.19.0; +https://lemmy.world", "Tumblr/14.0.835.186", "Iframely/1.3.1", "Python-urllib/3.11", "node-fetch/1.0", "axios/1.6.0", "Java/17.0.1", "Scrapy/2.11", "Google-InspectionTool/1.0"]) {
      expect(isBotUserAgent(ua), ua).toBe(true);
    }
  });
  it("does not mistake a real phone for a bot (Cubot)", () => {
    expect(isBotUserAgent("Mozilla/5.0 (Linux; Android 11; CUBOT_X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36")).toBe(false);
  });
  it("treats a normal browser as a person", () => {
    expect(isBotUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isBotUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")).toBe(false);
  });
  it("a missing user agent counts as a bot (real browsers always send one)", () => {
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent("")).toBe(true);
  });
});

describe("unique click counting is permanently off", () => {
  it("ships no visitor-hash helper at all, so no visitor identifier can ever be generated", () => {
    expect(Object.keys(helpers).sort()).toEqual(["CODE_RE", "HOME_URL", "PLATFORM_RE", "isBotUserAgent", "newCode", "parseDestination"]);
  });
});

describe("newCode", () => {
  it("makes 8-character URL-safe codes that fit the database check, with no repeats in a big sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const c = newCode();
      expect(c).toMatch(CODE_RE);
      expect(c).toHaveLength(8);
      seen.add(c);
    }
    expect(seen.size).toBe(500);
  });
});

describe("HOME_URL", () => {
  it("is the fixed place a stale or broken link sends the visitor", () => {
    expect(HOME_URL).toBe("https://lazyrelay.com/");
    expect(parseDestination(HOME_URL)).toBe(HOME_URL);
  });
});
