import { describe, it, expect } from "vitest";
import { normalizePostOptions, normalizeStoredOptions, optionsForPlatform, CHAIN_ITEM_MAX_LENGTH, MAX_CHAIN_ITEMS } from "./postOptions.js";

const none = { mediaUrl: null, mediaUrls: [] };
const img = { mediaUrl: "https://cdn.example.com/a.jpg", mediaUrls: [] };
const vid = { mediaUrl: "https://cdn.example.com/a.mp4", mediaUrls: [] };
const carousel = { mediaUrl: "https://cdn.example.com/a.jpg", mediaUrls: ["https://cdn.example.com/b.jpg"] };

describe("normalizePostOptions: routing by platform", () => {
  it("nothing given is fine everywhere", () => {
    expect(normalizePostOptions(undefined, "tiktok", none)).toEqual({ ok: true, options: {} });
    expect(normalizePostOptions({}, "pinterest", none)).toEqual({ ok: true, options: {} });
  });
  it("refuses a key that belongs to another platform, naming the right one", () => {
    const r = normalizePostOptions({ youtube: { privacy: "private" } }, "tiktok", none);
    expect(r).toEqual({ ok: false, error: "options.youtube is not used by this platform (it takes options.tiktok)" });
    expect(normalizePostOptions({ tiktok: { aiGenerated: true } }, "pinterest", none).ok).toBe(false);
  });
  it("threads, bluesky, mastodon and x all read the chain key", () => {
    for (const p of ["threads", "bluesky", "mastodon", "x"]) {
      expect(normalizePostOptions({ chain: ["one"] }, p, none)).toEqual({ ok: true, options: { chain: ["one"] } });
    }
  });
  it("rejects a non-object", () => {
    expect(normalizePostOptions("nope", "tiktok", none).ok).toBe(false);
    expect(normalizePostOptions([], "tiktok", none).ok).toBe(false);
  });
});

describe("TikTok", () => {
  it("takes the AI label as a boolean", () => {
    expect(normalizePostOptions({ tiktok: { aiGenerated: true } }, "tiktok", none)).toEqual({ ok: true, options: { tiktok: { aiGenerated: true } } });
    expect(normalizePostOptions({ tiktok: { aiGenerated: "yes" } }, "tiktok", none).ok).toBe(false);
  });
});

describe("YouTube", () => {
  it("cleans and keeps visibility, kids flag, title and tags", () => {
    const r = normalizePostOptions({ youtube: { title: "  My video ", privacy: "unlisted", madeForKids: false, aiGenerated: true, tags: ["#Tips", "tips", " how to "] } }, "youtube", vid);
    expect(r).toEqual({ ok: true, options: { youtube: { title: "My video", privacy: "unlisted", madeForKids: false, aiGenerated: true, tags: ["Tips", "tips", "how to"] } } });
  });
  it("refuses bad values", () => {
    expect(normalizePostOptions({ youtube: { privacy: "secret" } }, "youtube", vid).ok).toBe(false);
    expect(normalizePostOptions({ youtube: { title: "x".repeat(101) } }, "youtube", vid).ok).toBe(false);
    expect(normalizePostOptions({ youtube: { madeForKids: "no" } }, "youtube", vid).ok).toBe(false);
    expect(normalizePostOptions({ youtube: { tags: Array.from({ length: 16 }, (_, i) => `t${i}`) } }, "youtube", vid).ok).toBe(false);
    expect(normalizePostOptions({ youtube: { tags: ["x".repeat(31)] } }, "youtube", vid).ok).toBe(false);
  });
  it("an empty object means nothing to send", () => {
    expect(normalizePostOptions({ youtube: {} }, "youtube", vid)).toEqual({ ok: true, options: {} });
  });
});

describe("Instagram", () => {
  it("stories need media and are a single item", () => {
    expect(normalizePostOptions({ instagram: { placement: "story" } }, "instagram", img).ok).toBe(true);
    expect(normalizePostOptions({ instagram: { placement: "story" } }, "instagram", vid).ok).toBe(true);
    expect(normalizePostOptions({ instagram: { placement: "story" } }, "instagram", none).ok).toBe(false);
    expect(normalizePostOptions({ instagram: { placement: "story" } }, "instagram", carousel).ok).toBe(false);
  });
  it("a reel needs a video; a lone video cannot be a feed post", () => {
    expect(normalizePostOptions({ instagram: { placement: "reel" } }, "instagram", vid).ok).toBe(true);
    expect(normalizePostOptions({ instagram: { placement: "reel" } }, "instagram", img).ok).toBe(false);
    expect(normalizePostOptions({ instagram: { placement: "feed" } }, "instagram", vid).ok).toBe(false);
    expect(normalizePostOptions({ instagram: { placement: "feed" } }, "instagram", img).ok).toBe(true);
  });
  it("a trial reel is a single video reel, with an optional graduation", () => {
    expect(normalizePostOptions({ instagram: { trialReel: true, trialGraduation: "auto" } }, "instagram", vid)).toEqual({ ok: true, options: { instagram: { trialReel: true, trialGraduation: "auto" } } });
    expect(normalizePostOptions({ instagram: { trialReel: true } }, "instagram", img).ok).toBe(false);
    expect(normalizePostOptions({ instagram: { trialReel: true, placement: "story" } }, "instagram", vid).ok).toBe(false);
    expect(normalizePostOptions({ instagram: { trialGraduation: "auto" } }, "instagram", vid).ok).toBe(false);
  });
});

describe("Facebook", () => {
  it("a story needs one image or video", () => {
    expect(normalizePostOptions({ facebook: { placement: "story" } }, "facebook", img).ok).toBe(true);
    expect(normalizePostOptions({ facebook: { placement: "story" } }, "facebook", none).ok).toBe(false);
    expect(normalizePostOptions({ facebook: { placement: "story" } }, "facebook", carousel).ok).toBe(false);
    expect(normalizePostOptions({ facebook: { placement: "sideways" } }, "facebook", img).ok).toBe(false);
  });
});

describe("LinkedIn document", () => {
  it("takes an https PDF and a title, and not together with images", () => {
    const doc = { linkedin: { documentUrl: "https://cdn.example.com/deck.pdf", documentTitle: "Our deck" } };
    expect(normalizePostOptions(doc, "linkedin", none)).toEqual({ ok: true, options: doc });
    expect(normalizePostOptions(doc, "linkedin", img).ok).toBe(false);
    expect(normalizePostOptions({ linkedin: { documentUrl: "https://cdn.example.com/deck.png" } }, "linkedin", none).ok).toBe(false);
    expect(normalizePostOptions({ linkedin: { documentUrl: "http://cdn.example.com/deck.pdf" } }, "linkedin", none).ok).toBe(false);
    expect(normalizePostOptions({ linkedin: { documentTitle: "orphan" } }, "linkedin", none).ok).toBe(false);
  });
});

describe("thread chains", () => {
  it("keeps clean follow-ups in order", () => {
    expect(normalizePostOptions({ chain: [" two ", "three"] }, "threads", none)).toEqual({ ok: true, options: { chain: ["two", "three"] } });
  });
  it("respects each platform's own length limit and the item cap", () => {
    for (const [p, max] of Object.entries(CHAIN_ITEM_MAX_LENGTH)) {
      expect(normalizePostOptions({ chain: ["x".repeat(max)] }, p, none).ok, `${p} at limit`).toBe(true);
      expect(normalizePostOptions({ chain: ["x".repeat(max + 1)] }, p, none).ok, `${p} over limit`).toBe(false);
    }
    expect(normalizePostOptions({ chain: Array.from({ length: MAX_CHAIN_ITEMS + 1 }, () => "a") }, "threads", none).ok).toBe(false);
    expect(normalizePostOptions({ chain: ["ok", ""] }, "threads", none).ok).toBe(false);
    expect(normalizePostOptions({ chain: "nope" }, "threads", none).ok).toBe(false);
  });
});

describe("normalizeStoredOptions (drafts and recurring schedules)", () => {
  it("keeps several platforms' options together", () => {
    const r = normalizeStoredOptions({ tiktok: { aiGenerated: true }, chain: ["a"], instagram: { placement: "story" } });
    expect(r).toEqual({ ok: true, options: { tiktok: { aiGenerated: true }, chain: ["a"], instagram: { placement: "story" } } });
  });
  it("still refuses a wrongly shaped value or an unknown group", () => {
    expect(normalizeStoredOptions({ tiktok: { aiGenerated: "yes" } }).ok).toBe(false);
    expect(normalizeStoredOptions({ myspace: {} }).ok).toBe(false);
    expect(normalizeStoredOptions({ chain: "nope" }).ok).toBe(false);
  });
});

describe("optionsForPlatform (a recurring schedule fanned out)", () => {
  const stored = { tiktok: { aiGenerated: true }, chain: ["a"], instagram: { placement: "story" as const } };
  it("gives each platform only its own key", () => {
    expect(optionsForPlatform(stored, "tiktok", none)).toEqual({ tiktok: { aiGenerated: true } });
    expect(optionsForPlatform(stored, "bluesky", none)).toEqual({ chain: ["a"] });
    expect(optionsForPlatform(stored, "pinterest", none)).toEqual({});
  });
  it("drops options that do not fit this post instead of failing the schedule", () => {
    expect(optionsForPlatform(stored, "instagram", none)).toEqual({}); // a story needs media
    expect(optionsForPlatform(stored, "instagram", img)).toEqual({ instagram: { placement: "story" } });
    expect(optionsForPlatform(null, "instagram", img)).toEqual({});
  });
});
