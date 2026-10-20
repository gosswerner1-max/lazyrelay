// Header mapper tests. Layouts are STATED from public documentation, NOT verified against real exports.

import { describe, it, expect } from "vitest";
import { mapColumns, resolveMapping } from "./headerMap.js";
import { CsvMigrationError } from "./parseCsv.js";

describe("mapColumns (stated layouts, not real exports)", () => {
  it("maps the stated Buffer headers and labels the file", () => {
    expect(mapColumns(["Text", "Link", "Posting Time"])).toMatchObject({ detected: "buffer", columns: { text: "Text", link: "Link", time: "Posting Time" } });
  });

  it("maps the stated Hootsuite headers and labels the file", () => {
    expect(mapColumns(["Date", "Text", "URL"])).toMatchObject({ detected: "hootsuite", columns: { text: "Text", link: "URL", time: "Date" } });
  });

  it("is case-insensitive, trims, and understands aliases", () => {
    const m = mapColumns(["  MESSAGE ", "Shared Link", "Scheduled For"]);
    expect(m.columns).toEqual({ text: "  MESSAGE ", link: "Shared Link", time: "Scheduled For" });
    expect(m.detected).toBe("unknown");
    expect(mapColumns(["Caption", "Link URL", "Publish Date"]).columns).toEqual({ text: "Caption", link: "Link URL", time: "Publish Date" });
    expect(mapColumns(["body", "attachment", "send at"]).columns).toEqual({ text: "body", link: "attachment", time: "send at" });
  });

  it("strips a BOM left on the first header", () => {
    expect(mapColumns(["﻿Text", "Link"]).columns.text).toBe("﻿Text");
    expect(mapColumns(["﻿Text", "Link"]).detected).toBe("unknown");
  });

  it("prefers the earlier alias when two columns could be the text", () => {
    expect(mapColumns(["Status", "Text", "Link"]).columns.text).toBe("Text");
  });

  it("lists media-like columns as ignored and never maps them", () => {
    const m = mapColumns(["Text", "Image", "Profile", "Network", "Labels", "Posting Time"]);
    expect(m.ignored).toEqual(["Image", "Profile", "Network", "Labels"]);
    expect(m.columns.link).toBeNull();
  });

  it("reports needsMapping when no text column can be found", () => {
    const m = mapColumns(["Foo", "Bar"]);
    expect(m.columns.text).toBeNull();
    expect(m.needsMapping).toBe(true);
    expect(m.detected).toBe("unknown");
  });
});

describe("resolveMapping", () => {
  const headers = ["Foo", "Bar", "Baz"];
  it("uses the caller's override when each column exists (case-insensitive, trimmed)", () => {
    expect(resolveMapping(headers, { text: " foo ", time: "BAZ" })).toMatchObject({ columns: { text: "Foo", link: null, time: "Baz" }, needsMapping: false });
  });

  it("refuses an override naming a column that is not in the file", () => {
    try {
      resolveMapping(headers, { text: "Nope" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CsvMigrationError);
      expect((e as CsvMigrationError).code).toBe("invalid_mapping");
      expect((e as CsvMigrationError).status).toBe(400);
    }
  });

  it("falls back to detection for a field the override leaves out", () => {
    expect(resolveMapping(["Text", "Link"], { link: "Link" }).columns.text).toBe("Text");
  });
});
