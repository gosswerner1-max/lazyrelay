import { describe, it, expect } from "vitest";
import { insertSnippet } from "./snippets";

describe("insertSnippet", () => {
  it("fills an empty post", () => {
    expect(insertSnippet("", "#a #b")).toBe("#a #b");
    expect(insertSnippet("   ", "#a #b")).toBe("#a #b");
  });
  it("adds to the end on its own paragraph", () => {
    expect(insertSnippet("Big news today.", "#a #b")).toBe("Big news today.\n\n#a #b");
    expect(insertSnippet("Big news today.\n", "#a #b")).toBe("Big news today.\n\n#a #b");
  });
  it("does not add the same text twice in a row", () => {
    const once = insertSnippet("Hello", "Cheers, Sam");
    expect(insertSnippet(once, "Cheers, Sam")).toBe(once);
  });
  it("ignores an empty snippet", () => {
    expect(insertSnippet("Hello", "  ")).toBe("Hello");
  });
});
