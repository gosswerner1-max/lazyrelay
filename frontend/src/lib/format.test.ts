import { describe, it, expect } from "vitest";
import { formatBytes } from "./format";

describe("formatBytes", () => {
  it("formats exactly 1GB", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00GB");
  });

  it("formats under 1GB in MB", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0MB");
  });
});
