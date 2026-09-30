import { describe, it, expect } from "vitest";
import { parseTags } from "./postTags";

describe("parseTags", () => {
  it("gives nothing for empty text", () => {
    expect(parseTags("")).toBeUndefined();
    expect(parseTags(" , ,")).toBeUndefined();
  });
  it("splits on commas, cleans, lowercases and removes repeats", () => {
    expect(parseTags("Launch, #Give Away ,launch")).toEqual(["launch", "give away"]);
  });
});
