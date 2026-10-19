import { describe, expect, it } from "vitest";
import { CSV_MAX_BYTES, URL_MAX_LENGTH, contentSourceDrafts, draftTitle, originFromTags, validateCsvFile, validateSourceUrl } from "./contentSources";
import type { ScheduledPost } from "./api";

const DASH = /[–—]/;

describe("validateSourceUrl", () => {
  it("accepts a plain https address and trims it", () => {
    expect(validateSourceUrl("  https://example.com/feed.xml  ")).toEqual({ ok: true, url: "https://example.com/feed.xml" });
  });

  it("accepts https with a port and a public IP literal", () => {
    expect(validateSourceUrl("https://example.com:8443/rss").ok).toBe(true);
    expect(validateSourceUrl("https://8.8.8.8/sitemap.xml").ok).toBe(true);
    expect(validateSourceUrl("https://172.32.0.1/sitemap.xml").ok).toBe(true);
  });

  it("rejects an empty value", () => {
    const r = validateSourceUrl("   ");
    expect(r.ok).toBe(false);
  });

  it("rejects http and other schemes", () => {
    for (const bad of ["http://example.com/feed", "ftp://example.com/feed", "javascript:alert(1)", "not a url", "example.com/feed"]) {
      expect(validateSourceUrl(bad).ok, bad).toBe(false);
    }
  });

  it("rejects a username or password in the address", () => {
    for (const bad of ["https://user:pass@example.com/feed", "https://user@example.com/feed", "https://:pass@example.com/feed"]) {
      const r = validateSourceUrl(bad);
      expect(r.ok, bad).toBe(false);
    }
  });

  it("rejects localhost, private, link-local and loopback literals", () => {
    const bad = [
      "https://localhost/feed",
      "https://LOCALHOST/feed",
      "https://app.localhost/feed",
      "https://127.0.0.1/feed",
      "https://127.5.5.5/feed",
      "https://0.0.0.0/feed",
      "https://10.0.0.5/feed",
      "https://192.168.1.10/feed",
      "https://172.16.0.1/feed",
      "https://172.31.255.255/feed",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/feed",
      "https://2130706433/feed",
      "https://[::1]/feed",
      "https://[::]/feed",
      "https://[fe80::1]/feed",
      "https://[fd00::1]/feed",
      "https://[fc00::1]/feed",
      "https://[::ffff:127.0.0.1]/feed",
      "https://[::ffff:10.1.2.3]/feed",
    ];
    for (const b of bad) expect(validateSourceUrl(b).ok, b).toBe(false);
  });

  it("rejects an address longer than the cap", () => {
    expect(URL_MAX_LENGTH).toBe(2048);
    const long = "https://example.com/" + "a".repeat(URL_MAX_LENGTH);
    expect(validateSourceUrl(long).ok).toBe(false);
    const edge = "https://example.com/" + "a".repeat(URL_MAX_LENGTH - "https://example.com/".length);
    expect(edge.length).toBe(URL_MAX_LENGTH);
    expect(validateSourceUrl(edge).ok).toBe(true);
  });

  it("gives plain-language errors with no em or en dash and no engine jargon", () => {
    for (const bad of ["", "http://a.com", "https://u:p@a.com", "https://localhost", "https://10.0.0.1", "nope", "https://a.com/" + "a".repeat(2100)]) {
      const r = validateSourceUrl(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.length).toBeGreaterThan(10);
        expect(r.error).not.toMatch(DASH);
        expect(r.error).not.toMatch(/scraper|crawler/i);
      }
    }
  });
});

describe("validateCsvFile", () => {
  it("names the cap as a 5 MB constant", () => {
    expect(CSV_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it("accepts a .csv file up to the cap, any letter case", () => {
    expect(validateCsvFile({ name: "posts.csv", size: 100 }).ok).toBe(true);
    expect(validateCsvFile({ name: "POSTS.CSV", size: CSV_MAX_BYTES }).ok).toBe(true);
  });

  it("rejects other file types", () => {
    for (const name of ["notes.txt", "data.csv.exe", "sheet.xlsx", "csv", "photo.png"]) {
      expect(validateCsvFile({ name, size: 100 }).ok, name).toBe(false);
    }
  });

  it("rejects a file over the cap and an empty file", () => {
    expect(validateCsvFile({ name: "big.csv", size: CSV_MAX_BYTES + 1 }).ok).toBe(false);
    expect(validateCsvFile({ name: "empty.csv", size: 0 }).ok).toBe(false);
  });

  it("gives plain messages without em or en dashes", () => {
    for (const f of [{ name: "a.txt", size: 1 }, { name: "a.csv", size: CSV_MAX_BYTES + 1 }, { name: "a.csv", size: 0 }]) {
      const r = validateCsvFile(f);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toMatch(DASH);
    }
  });
});

describe("originFromTags (the one place that knows the cs: tag format)", () => {
  it("reads type and name from cs:<type>:<name>", () => {
    expect(originFromTags(["cs:rss:My blog"])).toEqual({ type: "rss", name: "My blog" });
    expect(originFromTags(["promo", "cs:sitemap:Shop"])).toEqual({ type: "sitemap", name: "Shop" });
    expect(originFromTags(["cs:csv:Spring list"])).toEqual({ type: "csv", name: "Spring list" });
  });

  it("is case-insensitive on the prefix and type (the backend lowercases tags) and keeps a colon in the name", () => {
    expect(originFromTags(["CS:RSS:Daily: news"])).toEqual({ type: "rss", name: "Daily: news" });
  });

  it("returns null when there is no cs: tag", () => {
    expect(originFromTags(["promo", "csv"])).toBeNull();
    expect(originFromTags([])).toBeNull();
    expect(originFromTags(null)).toBeNull();
    expect(originFromTags(undefined)).toBeNull();
  });

  it("still recognises an unknown type or a missing name as a content source tag", () => {
    expect(originFromTags(["cs:youtube:x"])).toEqual({ type: null, name: "x" });
    expect(originFromTags(["cs:rss:"])).toEqual({ type: "rss", name: "" });
    expect(originFromTags(["cs:"])).toEqual({ type: null, name: "" });
  });
});

describe("draftTitle", () => {
  it("uses the first non-empty line, trimmed and collapsed", () => {
    expect(draftTitle("\n\n  Ten tips   for   spring \nBody text")).toBe("Ten tips for spring");
  });

  it("shortens a very long first line", () => {
    const t = draftTitle("x".repeat(500));
    expect(t.length).toBeLessThanOrEqual(120);
    expect(t.endsWith("...")).toBe(true);
  });

  it("falls back to a plain label for empty content", () => {
    expect(draftTitle("   ")).toBe("Untitled draft");
  });
});

const post = (over: Partial<ScheduledPost>): ScheduledPost => ({ id: "p", content: "Hello", status: "draft", tags: [], ...over }) as ScheduledPost;

describe("contentSourceDrafts", () => {
  it("keeps only draft or needs_approval posts carrying a cs: tag", () => {
    const rows = contentSourceDrafts([
      post({ id: "a", status: "draft", tags: ["cs:rss:Blog"], content: "First headline\nbody" }),
      post({ id: "b", status: "draft", tags: ["promo"] }),
      post({ id: "c", status: "needs_approval", tags: ["cs:csv:List"], content: "Second" }),
      post({ id: "d", status: "pending", tags: ["cs:rss:Blog"] }),
      post({ id: "e", status: "posted", tags: ["cs:rss:Blog"] }),
      post({ id: "f", status: "draft", tags: null }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(rows[0]).toMatchObject({ origin: { type: "rss", name: "Blog" }, title: "First headline" });
    expect(rows[0].post.id).toBe("a");
  });
});
