// Preview analysis tests. Fixtures follow the STATED layouts (public documentation), they are NOT real exports.

import { describe, it, expect, vi } from "vitest";

vi.mock("../supabase.js", () => ({ supabase: {} }));

const { analyzeCsv, buildPreview } = await import("./analyze.js");
const { CsvMigrationError } = await import("./parseCsv.js");

const NOW = new Date("2029-06-15T10:00:00.000Z");
const csv = (s: string) => Buffer.from(s, "utf8");
const run = (s: string, o: Record<string, unknown> = {}) => analyzeCsv(csv(s), { now: NOW, ...o });

// STATED Buffer layout, not a real export.
const BUFFER_FILE = 'Text,Link,Posting Time\n"Launch day, big news",https://example.com/a,2030-05-17 14:30\nSecond post,,2020-01-01 10:00\n';
// STATED Hootsuite layout, not a real export. 17 as the first part proves day-first.
const HOOT_FILE = "Date,Text,URL\n17/05/2030 14:30,Hello there,https://example.com/h\n01/02/2030 09:00,Another,\n";

describe("analyzeCsv", () => {
  it("builds usable items from a stated Buffer layout and labels it", () => {
    const a = run(BUFFER_FILE);
    expect(a.detected).toBe("buffer");
    expect(a.rowsTotal).toBe(2);
    expect(a.items).toHaveLength(2);
    expect(a.items[0]).toMatchObject({ row: 2, text: "Launch day, big news", link: "https://example.com/a", plannedDate: "2030-05-17" });
    expect(a.items[0].content).toBe("Launch day, big news\n\nhttps://example.com/a");
    expect(a.items[1]).toMatchObject({ plannedDate: null });
    expect(a.noUsableDate).toBe(1);
    expect(a.timezone).toBe("UTC");
    expect(a.sourceTag).toBe("import:buffer");
  });

  it("reads a stated Hootsuite layout day-first when a first part is above 12", () => {
    const a = run(HOOT_FILE);
    expect(a.detected).toBe("hootsuite");
    expect(a.dateOrder).toBe("dmy");
    expect(a.items[1].plannedDate).toBe("2030-02-01");
    expect(a.sourceTag).toBe("import:hootsuite");
  });

  it("flags ambiguous slash dates, does not guess, and reads them once an order is given", () => {
    const file = "Text,Posting Time\nA,01/02/2030 09:00\nB,03/04/2030 09:00\n";
    const a = run(file);
    expect(a.dateOrder).toBe("ambiguous");
    expect(a.dateOrderRequired).toBe(true);
    expect(a.items.every((i) => i.plannedDate === null)).toBe(true);
    const b = run(file, { dateOrder: "mdy" });
    expect(b.dateOrderRequired).toBe(false);
    expect(b.items[0].plannedDate).toBe("2030-01-02");
    expect(run(file, { dateOrder: "dmy" }).items[0].plannedDate).toBe("2030-02-01");
  });

  it("ignores a caller's order when the file is unambiguous", () => {
    expect(run(HOOT_FILE, { dateOrder: "mdy" }).items[0].plannedDate).toBe("2030-05-17");
  });

  it("uses the request timezone", () => {
    const a = run("Text,Posting Time\nA,2030-05-17 01:00\n", { timezone: "Africa/Johannesburg" });
    expect(a.items[0]).toMatchObject({ plannedDate: "2030-05-17", plannedTime: "2030-05-16T23:00:00.000Z" });
    expect(a.timezone).toBe("Africa/Johannesburg");
  });

  it("refuses an unknown timezone", () => {
    expect(() => run(BUFFER_FILE, { timezone: "Mars/Base" })).toThrowError(CsvMigrationError);
  });

  it("skips empty text and duplicates, with the spreadsheet row number", () => {
    const a = run("Text,Link\nHello,\n,https://example.com/x\nHello,\n  hello  ,\nOther,\n");
    expect(a.items.map((i) => i.row)).toEqual([2, 6]);
    expect(a.skipped).toEqual([
      { row: 3, reason: "empty_text" },
      { row: 4, reason: "duplicate" },
      { row: 5, reason: "duplicate" },
    ]);
  });

  it("does not append a link already inside the text and drops a link that is not http or https", () => {
    const a = run("Text,Link\nSee https://example.com/a now,https://example.com/a\nBad link,javascript:alert(1)\nOk,ftp://example.com/f\n");
    expect(a.items[0].content).toBe("See https://example.com/a now");
    expect(a.items[1]).toMatchObject({ link: null, content: "Bad link" });
    expect(a.items[1].issues.join(" ")).toMatch(/link/i);
    expect(a.items[2].link).toBeNull();
  });

  it("warns, but does not cut, when text is over the shortest platform limit, and skips what a draft cannot hold", () => {
    const a = run(`Text\n${"a".repeat(400)}\n${"b".repeat(5001)}\nshort\n`);
    expect(a.items).toHaveLength(2);
    expect(a.items[0].content).toHaveLength(400);
    expect(a.items[0].issues.join(" ")).toMatch(/character limit/);
    expect(a.items[1].issues).toEqual([]);
    expect(a.skipped).toEqual([{ row: 3, reason: "too_long" }]);
  });

  it("counts an appended link toward the draft length", () => {
    const a = run(`Text,Link\n${"a".repeat(4990)},https://example.com/${"p".repeat(30)}\n`);
    expect(a.skipped).toEqual([{ row: 2, reason: "too_long" }]);
  });

  it("asks for a mapping when no text column is found and returns headers and sample rows", () => {
    const a = run("Foo,Bar\n1,2\n3,4\n5,6\n7,8\n");
    expect(a.needsMapping).toBe(true);
    expect(a.headers).toEqual(["Foo", "Bar"]);
    expect(a.sampleRows).toEqual([["1", "2"], ["3", "4"], ["5", "6"]]);
    expect(a.items).toEqual([]);
  });

  it("applies a caller's column choice", () => {
    const a = run("Foo,Bar\nfirst post,https://example.com/1\n", { mapping: { text: "Foo", link: "Bar" } });
    expect(a.needsMapping).toBe(false);
    expect(a.items[0]).toMatchObject({ text: "first post", link: "https://example.com/1" });
  });

  it("tolerates ragged rows and notes ignored columns without reading them", () => {
    const a = run("Text,Image,Profile\nOnly text\nTwo,http://img.example.com/a.png,acct\n");
    expect(a.items).toHaveLength(2);
    expect(a.warnings.join(" ")).toMatch(/Image/);
    expect(a.items[1].content).toBe("Two");
  });

  it("keeps formula-looking text as plain text and strips control characters", () => {
    const a = run('Text\n"=HYPERLINK(""http://x"")"\n"ok\u0007‮"\n');
    expect(a.items[0].text).toBe('=HYPERLINK("http://x")');
    expect(a.items[1].text).toBe("ok");
  });

  it("gives the same fingerprint for the same content in a different dress, and a different one when it changes", () => {
    const base = run("Text,Link\nHello,\nWorld,\n");
    expect(run("﻿Text;Link\r\nHello;\r\nWorld;\r\n").fingerprint).toBe(base.fingerprint);
    expect(run("Text,Link\nHello,\nWorld!,\n").fingerprint).not.toBe(base.fingerprint);
    expect(base.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives each usable row a stable import tag within the tag length rule", () => {
    const a = run("Text\nA\nB\n");
    const tags = a.items.map((i) => i.importTag);
    expect(new Set(tags).size).toBe(2);
    for (const t of tags) expect(t).toMatch(/^ih-[0-9a-f]{16}$/);
    expect(run("Text\nA\nB\n").items.map((i) => i.importTag)).toEqual(tags);
  });
});

describe("buildPreview", () => {
  it("returns the documented shape and creates nothing", () => {
    const p = buildPreview(run(BUFFER_FILE));
    expect(Object.keys(p).sort()).toEqual(
      ["columns", "dateOrder", "detected", "fileFingerprint", "ignoredColumns", "needsMapping", "noUsableDate", "rows", "rowsTotal", "rowsUsable", "skipped", "timezone", "warnings"].sort(),
    );
    expect(p.columns).toEqual({ text: "Text", link: "Link", time: "Posting Time" });
    expect(p.rows[0]).toEqual({ row: 2, text: "Launch day, big news", link: "https://example.com/a", plannedDate: "2030-05-17", plannedTime: "2030-05-17T14:30:00.000Z", issues: [] });
    expect(p.rowsUsable).toBe(2);
  });

  it("shows at most 20 rows with long text cut to an excerpt (display only)", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `Post ${i} ${"x".repeat(300)}`).join("\n");
    const p = buildPreview(run(`Text\n${rows}\n`));
    expect(p.rows).toHaveLength(20);
    expect(p.rows[0].text.length).toBeLessThanOrEqual(141);
    expect(p.rowsUsable).toBe(30);
  });

  it("adds headers and sample rows only when a mapping is needed", () => {
    const needs = buildPreview(run("Foo,Bar\n1,2\n"));
    expect(needs).toMatchObject({ needsMapping: true, headers: ["Foo", "Bar"], sampleRows: [["1", "2"]] });
    expect("headers" in buildPreview(run(BUFFER_FILE))).toBe(false);
  });
});
