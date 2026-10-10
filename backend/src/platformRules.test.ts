import { describe, it, expect, vi } from "vitest";

// postCreation.ts imports supabase.ts, which throws without env vars. Nothing here touches a database.
vi.mock("./supabase.js", () => ({ supabase: { from: () => ({}) } }));

const { getPlatformRules } = await import("./platformRules.js");
const { MULTI_MEDIA_RULES } = await import("./carousel.js");
const { CHAIN_ITEM_MAX_LENGTH, OPTION_KEY_FOR_PLATFORM } = await import("./postOptions.js");

const EXPECTED = [
  "instagram", "facebook", "tiktok", "youtube", "pinterest", "linkedin", "threads",
  "bluesky", "mastodon", "x", "tumblr", "telegram", "discord",
  "wordpress", "devto", "hashnode", "lemmy", "slack", "nostr", "whop", "whatsapp",
];

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => allStrings(v, out));
  return out;
}

describe("getPlatformRules", () => {
  it("has every platform exactly once", () => {
    const names = getPlatformRules().map((r) => r.platform);
    expect([...names].sort()).toEqual([...EXPECTED].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it("returns one entry for a named platform and [] for an unknown one", () => {
    expect(getPlatformRules("tiktok")).toHaveLength(1);
    expect(getPlatformRules("TikTok")).toHaveLength(1);
    expect(getPlatformRules("myspace")).toEqual([]);
  });

  it("tiktok requires tiktokPrivacyLevel and pinterest requires boardId", () => {
    expect(getPlatformRules("tiktok")[0].required).toContain("tiktokPrivacyLevel");
    expect(getPlatformRules("pinterest")[0].required).toContain("boardId");
  });

  it("multiItem matches MULTI_MEDIA_RULES, and is null for every other platform", () => {
    for (const r of getPlatformRules()) {
      const rule = MULTI_MEDIA_RULES[r.platform];
      if (rule) expect(r.media.multiItem).toEqual({ maxItems: rule.max, videosAllowed: rule.videos });
      else expect(r.media.multiItem).toBeNull();
    }
  });

  it("chain-capable platforms list chain in options with the repo text length", () => {
    for (const [platform, key] of Object.entries(OPTION_KEY_FOR_PLATFORM)) {
      const r = getPlatformRules(platform)[0];
      expect(r.options.some((o) => o.startsWith(`${key}:`))).toBe(true);
      if (key === "chain") expect(r.text.maxLength).toBe(CHAIN_ITEM_MAX_LENGTH[platform]);
    }
    for (const r of getPlatformRules()) {
      if (!(r.platform in OPTION_KEY_FOR_PLATFORM)) expect(r.options).toEqual([]);
    }
  });

  it("only uses the allowed lookup tools", () => {
    const allowed = ["list_pinterest_boards", "get_tiktok_creator_info", "list_connected_accounts", "get_next_free_slot"];
    for (const r of getPlatformRules()) r.lookups.forEach((l) => expect(allowed).toContain(l));
    expect(getPlatformRules("pinterest")[0].lookups).toContain("list_pinterest_boards");
    expect(getPlatformRules("tiktok")[0].lookups).toContain("get_tiktok_creator_info");
  });

  it("the four limits corrected on 2026-10-02 match the platforms' own documented numbers", () => {
    // Pinterest create_pin description: 800 characters (pins-create reference).
    expect(getPlatformRules("pinterest")[0].text.maxLength).toBe(800);
    // Threads carousel: 20 items (Threads API docs).
    expect(getPlatformRules("threads")[0].media.multiItem).toEqual({ maxItems: 20, videosAllowed: true });
    // Bluesky image blob: 2,000,000 bytes (lexicon), stated as 1.9 MB so it never promises more than that.
    expect(getPlatformRules("bluesky")[0].media.image.maxSizeMb).toBe(1.9);
    // Mastodon image default: 16 MB (docs.joinmastodon.org/user/posting).
    expect(getPlatformRules("mastodon")[0].media.image.maxSizeMb).toBe(16);
  });

  it("pinterest carries the repo cap and mentions the warm-up ramp", () => {
    const p = getPlatformRules("pinterest")[0];
    expect(p.limits.rollingPostsPer24h).toBeGreaterThan(0);
    expect(p.limits.note.toLowerCase()).toContain("warm-up");
    expect(getPlatformRules("x")[0].limits.rollingPostsPer24h).toBeNull();
  });

  it("round-trips through JSON", () => {
    const all = getPlatformRules();
    expect(JSON.parse(JSON.stringify(all))).toEqual(all);
  });

  it("has no em dash or en dash in any string", () => {
    for (const s of allStrings(getPlatformRules())) {
      expect(s).not.toMatch(/[–—]/);
    }
  });

  it("every entry with a non-null text limit that is not a repo constant has a source URL", () => {
    for (const r of getPlatformRules()) {
      const fromRepo = r.platform in CHAIN_ITEM_MAX_LENGTH;
      if (r.text.maxLength !== null && !fromRepo) {
        expect(r.sources.length, r.platform).toBeGreaterThan(0);
      }
      r.sources.forEach((u) => expect(u).toMatch(/^https:\/\//));
    }
  });

  it("a null text limit says not verified", () => {
    for (const r of getPlatformRules()) {
      if (r.text.maxLength === null) expect(r.text.note.toLowerCase()).toContain("not verified");
    }
  });
});

describe("delayed first comment", () => {
  it("is listed for exactly the platforms that post first comments", async () => {
    const withIt = getPlatformRules().filter((p) => p.features.includes("delayed first comment")).map((p) => p.platform);
    expect(withIt.sort()).toEqual(["facebook", "instagram"]);
    const { FIRST_COMMENT_DELAY_PLATFORMS } = await import("./firstCommentDelay.js");
    expect([...FIRST_COMMENT_DELAY_PLATFORMS].sort()).toEqual(withIt);
  });
});
