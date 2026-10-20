// Parser tests. Every fixture here is a STATED layout or a hand-made edge case, NOT a real export.

import { describe, it, expect } from "vitest";
import { decodeCsvBuffer, parseCsvText, sanitizeCell, CsvMigrationError } from "./parseCsv.js";
import { MAX_CSV_ROWS, MAX_CSV_COLUMNS, MAX_CELL_CHARS } from "./limits.js";

const buf = (s: string) => Buffer.from(s, "utf8");
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof CsvMigrationError ? e.code : "other";
  }
  return undefined;
};

describe("decodeCsvBuffer", () => {
  it("reads UTF-8 with and without a BOM", () => {
    expect(decodeCsvBuffer(buf("a,b\n1,2"))).toBe("a,b\n1,2");
    expect(decodeCsvBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf("a,b\n1,2")]))).toBe("a,b\n1,2");
  });

  it("refuses UTF-16 with a friendly 415 asking for UTF-8", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b\n1,2", "utf16le")]);
    let err: CsvMigrationError | undefined;
    try {
      decodeCsvBuffer(le);
    } catch (e) {
      err = e as CsvMigrationError;
    }
    expect(err?.status).toBe(415);
    expect(err?.code).toBe("encoding_unsupported");
    expect(err?.message).toMatch(/UTF-8/);
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("a,b", "utf16le").swap16()]);
    expect(codeOf(() => decodeCsvBuffer(be))).toBe("encoding_unsupported");
  });

  it("refuses bytes that are not valid UTF-8", () => {
    expect(codeOf(() => decodeCsvBuffer(Buffer.from([0x61, 0x2c, 0xe9, 0x0a, 0x31])))).toBe("encoding_unsupported");
  });

  it("refuses empty, zip and binary uploads with a friendly 400", () => {
    expect(codeOf(() => decodeCsvBuffer(Buffer.alloc(0)))).toBe("empty_file");
    expect(codeOf(() => decodeCsvBuffer(buf("   \n  \n")))).toBe("empty_file");
    expect(codeOf(() => decodeCsvBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])))).toBe("not_text");
    expect(codeOf(() => decodeCsvBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01])))).toBe("not_text");
    expect(codeOf(() => decodeCsvBuffer(Buffer.from("a,b\u0000\u0000,c")))).toBe("not_text");
  });

  it("refuses a file over the byte cap with 413", () => {
    let err: CsvMigrationError | undefined;
    try {
      decodeCsvBuffer(Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    } catch (e) {
      err = e as CsvMigrationError;
    }
    expect(err?.status).toBe(413);
    expect(err?.code).toBe("file_too_large");
  });
});

describe("parseCsvText (RFC 4180)", () => {
  it("parses a plain file with CRLF and LF line ends", () => {
    expect(parseCsvText("a,b\r\n1,2\r\n3,4\n")).toMatchObject({ headers: ["a", "b"], rows: [["1", "2"], ["3", "4"]], delimiter: "," });
  });

  it("handles quoted fields with commas, escaped quotes and embedded CR/LF", () => {
    const r = parseCsvText('Text,Link\r\n"Hello, world","say ""hi"""\r\n"line1\r\nline2",x\r\n');
    expect(r.rows[0]).toEqual(["Hello, world", 'say "hi"']);
    expect(r.rows[1]).toEqual(["line1\nline2", "x"]);
  });

  it("auto-detects semicolon and tab delimiters, ignoring delimiters inside quotes", () => {
    expect(parseCsvText("a;b\n1;2").delimiter).toBe(";");
    expect(parseCsvText("a\tb\n1\t2").delimiter).toBe("\t");
    const r = parseCsvText('Text;Link\n"a,b,c;d";x');
    expect(r.delimiter).toBe(";");
    expect(r.rows[0]).toEqual(["a,b,c;d", "x"]);
  });

  it("tolerates ragged rows and skips blank lines", () => {
    const r = parseCsvText("a,b,c\n1\n\n1,2,3,4\n");
    expect(r.rows).toEqual([["1"], ["1", "2", "3", "4"]]);
  });

  it("reports header only as a friendly 400", () => {
    expect(codeOf(() => parseCsvText("Text,Link\n"))).toBe("header_only");
  });

  it("rejects an unterminated quote", () => {
    expect(codeOf(() => parseCsvText('a,b\n"oops,2\n'))).toBe("malformed_csv");
  });

  it("enforces the row, column and cell caps", () => {
    const manyRows = "a\n" + Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `r${i}`).join("\n");
    expect(codeOf(() => parseCsvText(manyRows))).toBe("too_many_rows");
    const okRows = "a\n" + Array.from({ length: MAX_CSV_ROWS }, (_, i) => `r${i}`).join("\n");
    expect(parseCsvText(okRows).rows).toHaveLength(MAX_CSV_ROWS);
    const manyCols = Array.from({ length: MAX_CSV_COLUMNS + 1 }, (_, i) => `c${i}`).join(",") + "\n1";
    expect(codeOf(() => parseCsvText(manyCols))).toBe("too_many_columns");
    expect(codeOf(() => parseCsvText(`a\n${"x".repeat(MAX_CELL_CHARS + 1)}`))).toBe("cell_too_long");
    expect(parseCsvText(`a\n${"x".repeat(MAX_CELL_CHARS)}`).rows[0][0]).toHaveLength(MAX_CELL_CHARS);
  });
});

describe("sanitizeCell", () => {
  it("strips control and bidi characters but keeps newlines and tabs", () => {
    expect(sanitizeCell("a\u0000b\u0007c‮d⁦e‏f؜g\u007Fh")).toBe("abcdefgh");
    expect(sanitizeCell("l1\nl2\tx")).toBe("l1\nl2\tx");
  });

  it("keeps spreadsheet formula prefixes as plain text", () => {
    for (const s of ["=SUM(A1)", "+1", "-1", "@user", "=HYPERLINK(\"http://x\")"]) expect(sanitizeCell(s)).toBe(s);
  });
});
