import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/args.js";
import { shorten, table, formatTime } from "../src/format.js";

describe("parseArgs", () => {
  const spec = { value: ["text", "at"], repeat: ["media"], bool: ["approval"] };

  it("separates positionals, values, lists and booleans", () => {
    const p = parseArgs(["id1", "--text", "hello world", "--media", "a", "--media", "b", "--approval", "--json", "id2"], spec);
    expect(p.positional).toEqual(["id1", "id2"]);
    expect(p.values).toEqual({ text: "hello world" });
    expect(p.lists).toEqual({ media: ["a", "b"] });
    expect([...p.bools].sort()).toEqual(["approval", "json"]);
  });

  it("supports --name=value, including values with an equals sign", () => {
    const p = parseArgs(["--text=a=b", "--at=2026-10-01T09:00:00Z"], spec);
    expect(p.values).toEqual({ text: "a=b", at: "2026-10-01T09:00:00Z" });
  });

  it("lets the last value win for a single-value flag", () => {
    expect(parseArgs(["--text", "one", "--text", "two"], spec).values.text).toBe("two");
  });

  it("treats -h as help and everything after -- as positional", () => {
    expect(parseArgs(["-h"], spec).bools.has("help")).toBe(true);
    const p = parseArgs(["--", "--text", "x"], spec);
    expect(p.positional).toEqual(["--text", "x"]);
  });

  it("knows the global flags everywhere", () => {
    const p = parseArgs(["--key", "k", "--base-url", "http://x", "--json"], {});
    expect(p.values).toEqual({ key: "k", "base-url": "http://x" });
    expect(p.bools.has("json")).toBe(true);
  });

  it("throws UsageError for an unknown option, a missing value or a value on a boolean", () => {
    expect(() => parseArgs(["--nope"], spec)).toThrowError(UsageError);
    expect(() => parseArgs(["--text"], spec)).toThrowError("--text needs a value.");
    expect(() => parseArgs(["--text", "--at", "x"], spec)).toThrowError("--text needs a value.");
    expect(() => parseArgs(["--approval=yes"], spec)).toThrowError("--approval does not take a value.");
  });
});

describe("format helpers", () => {
  it("table aligns columns and trims trailing space", () => {
    const out = table(["A", "BB"], [["xxx", "1"], ["y", "22"]]);
    expect(out.split("\n")).toEqual(["A    BB", "---  --", "xxx  1", "y    22"]);
  });

  it("shorten flattens whitespace and cuts with dots", () => {
    expect(shorten("a\n b   c", 20)).toBe("a b c");
    expect(shorten("x".repeat(60), 10)).toBe("xxxxxxx...");
    expect(shorten(null, 10)).toBe("");
  });

  it("formatTime prints ISO without milliseconds and dashes for empty", () => {
    expect(formatTime("2026-10-01T09:00:00.000Z")).toBe("2026-10-01T09:00:00Z");
    expect(formatTime(null)).toBe("-");
    expect(formatTime("garbage")).toBe("garbage");
  });
});
