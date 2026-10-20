// Reads an uploaded CSV as DATA: decodes it, splits it into cells (RFC 4180 quoting, auto-detected delimiter) and cleans every
// cell. Nothing here evaluates, fetches or stores a cell. Cell contents never appear in an error message.

import { MAX_CELL_CHARS, MAX_CSV_BYTES, MAX_CSV_COLUMNS, MAX_CSV_ROWS } from "./limits.js";

export class CsvMigrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CsvMigrationError";
  }
}

export interface ParsedCsv {
  delimiter: "," | ";" | "\t";
  headers: string[];
  rows: string[][];
}

const SAVE_AS_UTF8 = "Save the file as CSV UTF-8 (in Excel: Save As, then CSV UTF-8) and upload it again.";
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const SNIFF_BYTES = 8192;
const CONTROL_AND_BIDI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;

/** Strips control and bidirectional-override characters. Keeps newlines and tabs. Formula prefixes (= + - @) stay as plain text. */
export function sanitizeCell(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_AND_BIDI, "");
}

function startsWith(buf: Buffer, bytes: number[]): boolean {
  return bytes.every((b, i) => buf[i] === b);
}

/** Bytes to text: UTF-8 with or without a BOM. Everything else gets a friendly refusal. */
export function decodeCsvBuffer(buf: Buffer): string {
  if (buf.length === 0) throw new CsvMigrationError(400, "empty_file", "That file is empty.");
  if (buf.length > MAX_CSV_BYTES) throw new CsvMigrationError(413, "file_too_large", "That file is over 2 MB. Split it into smaller files.");
  if (startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff])) {
    throw new CsvMigrationError(415, "encoding_unsupported", `That file is saved as UTF-16. ${SAVE_AS_UTF8}`);
  }
  if (startsWith(buf, ZIP_MAGIC) || buf.subarray(0, SNIFF_BYTES).includes(0)) {
    throw new CsvMigrationError(400, "not_text", "That does not look like a CSV text file. Export a CSV (not a zip or spreadsheet file) and upload it.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    throw new CsvMigrationError(415, "encoding_unsupported", `That file is not saved as UTF-8. ${SAVE_AS_UTF8}`);
  }
  text = text.replace(/^﻿/, "");
  if (text.trim() === "") throw new CsvMigrationError(400, "empty_file", "That file is empty.");
  return text;
}

/** The delimiter used by the first record, counted outside quotes. A single column file falls back to a comma. */
function detectDelimiter(text: string): ParsedCsv["delimiter"] {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const best = (Object.keys(counts) as ParsedCsv["delimiter"][]).reduce((a, b) => (counts[b] > counts[a] ? b : a), ",");
  return counts[best] > 0 ? best : ",";
}

function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let quotedField = false;
  const endField = () => {
    if (field.length > MAX_CELL_CHARS) throw new CsvMigrationError(400, "cell_too_long", `A cell is longer than ${MAX_CELL_CHARS} characters.`);
    record.push(field);
    field = "";
    quotedField = false;
    if (record.length > MAX_CSV_COLUMNS) throw new CsvMigrationError(400, "too_many_columns", `The file has more than ${MAX_CSV_COLUMNS} columns.`);
  };
  const endRecord = () => {
    endField();
    const blank = record.length === 1 && record[0] === "" && !quotedField;
    if (!blank) records.push(record);
    record = [];
    if (records.length > MAX_CSV_ROWS + 1) throw new CsvMigrationError(400, "too_many_rows", `The file has more than ${MAX_CSV_ROWS} rows. Split it into smaller files.`);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') (field += '"'), i++;
      else inQuotes = false;
    } else if (ch === '"' && field === "" && !quotedField) {
      inQuotes = true;
      quotedField = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new CsvMigrationError(400, "malformed_csv", "The file has a quote that is never closed. Check the file and upload it again.");
  if (field !== "" || record.length > 0 || quotedField) endRecord();
  return records;
}

export function parseCsvText(text: string): ParsedCsv {
  const delimiter = detectDelimiter(text);
  const records = splitRecords(text, delimiter).map((r) => r.map(sanitizeCell));
  if (records.length === 0) throw new CsvMigrationError(400, "empty_file", "That file is empty.");
  if (records.length === 1) throw new CsvMigrationError(400, "header_only", "The file has a header row but no posts.");
  return { delimiter, headers: records[0], rows: records.slice(1) };
}
