import { describe, it, expect } from "vitest";
import { normalizeTags } from "./postTags.js";

describe("normalizeTags", () => {
  it("treats missing tags as none", () => {
    expect(normalizeTags(undefined)).toEqual({ ok: true, tags: [] });
    expect(normalizeTags(null)).toEqual({ ok: true, tags: [] });
  });
  it("cleans, lowercases and de-duplicates", () => {
    expect(normalizeTags(["  #Launch ", "launch", "Give  Away", ""])).toEqual({ ok: true, tags: ["launch", "give away"] });
  });
  it("refuses more than 5 distinct tags", () => {
    const r = normalizeTags(["a", "b", "c", "d", "e", "f"]);
    expect(r.ok).toBe(false);
  });
  it("refuses a tag over 30 characters, and non-text input", () => {
    expect(normalizeTags(["x".repeat(31)]).ok).toBe(false);
    expect(normalizeTags("launch").ok).toBe(false);
    expect(normalizeTags([1]).ok).toBe(false);
  });
});
