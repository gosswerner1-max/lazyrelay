// Maps spreadsheet headers to the three fields we read (text, link, planned time). Tolerant: case, spacing, a BOM and common
// aliases are all accepted. The Buffer / Hootsuite layouts are ASSUMPTIONS taken from public documentation, not checked
// against real exports, so the detected label is information for the person only and nothing relies on it.

import { CsvMigrationError } from "./parseCsv.js";

export type DetectedTool = "buffer" | "hootsuite" | "unknown";
export type FieldName = "text" | "link" | "time";
export type ColumnChoice = Record<FieldName, string | null>;
export type MappingOverride = Partial<Record<FieldName, string | null>>;

export interface ColumnMapping {
  detected: DetectedTool;
  columns: ColumnChoice;
  /** Headers of columns we deliberately never read (media and account columns). */
  ignored: string[];
  needsMapping: boolean;
}

const ALIASES: Record<FieldName, string[]> = {
  text: ["text", "message", "content", "post", "caption", "copy", "body", "status", "update"],
  link: ["link", "url", "link url", "attachment", "shared link"],
  time: ["posting time", "date", "scheduled time", "scheduled for", "publish time", "publish date", "time", "datetime", "schedule", "send at"],
};
const IGNORED = new Set(["media", "image", "photo", "video", "profile", "account", "network", "channel", "platform", "labels", "tags"]);
const FIELDS: FieldName[] = ["text", "link", "time"];

export const normalizeHeader = (header: string): string => header.replace(/^﻿/, "").trim().replace(/\s+/g, " ").toLowerCase();

function findColumn(headers: string[], norm: string[], aliases: string[], taken: Set<number>): number {
  for (const alias of aliases) {
    const at = norm.findIndex((h, i) => h === alias && !taken.has(i));
    if (at >= 0) return at;
  }
  return -1;
}

function detectTool(norm: string[]): DetectedTool {
  const has = (h: string) => norm.includes(h);
  if (has("text") && has("posting time")) return "buffer";
  if (has("text") && has("date") && has("url")) return "hootsuite";
  return "unknown";
}

function build(headers: string[], picks: Record<FieldName, number>): ColumnMapping {
  const norm = headers.map(normalizeHeader);
  const columns = Object.fromEntries(FIELDS.map((f) => [f, picks[f] >= 0 ? headers[picks[f]] : null])) as ColumnChoice;
  const used = new Set(Object.values(picks));
  const ignored = headers.filter((_, i) => IGNORED.has(norm[i]) && !used.has(i));
  return { detected: detectTool(norm), columns, ignored, needsMapping: columns.text === null };
}

/** Header names to the fields we read, by alias. */
export function mapColumns(headers: string[]): ColumnMapping {
  const norm = headers.map(normalizeHeader);
  const taken = new Set<number>();
  const picks = { text: -1, link: -1, time: -1 } as Record<FieldName, number>;
  for (const field of FIELDS) {
    picks[field] = findColumn(headers, norm, ALIASES[field], taken);
    if (picks[field] >= 0) taken.add(picks[field]);
  }
  return build(headers, picks);
}

/** Detection, with any column the caller named taking priority. A named column that is not in the file is refused. */
export function resolveMapping(headers: string[], override?: MappingOverride): ColumnMapping {
  const norm = headers.map(normalizeHeader);
  const auto = mapColumns(headers);
  const picks = { text: -1, link: -1, time: -1 } as Record<FieldName, number>;
  for (const field of FIELDS) {
    const named = override?.[field];
    if (named === undefined || named === null || named.trim() === "") {
      picks[field] = auto.columns[field] === null ? -1 : headers.indexOf(auto.columns[field] as string);
      continue;
    }
    const at = norm.indexOf(normalizeHeader(named));
    if (at < 0) throw new CsvMigrationError(400, "invalid_mapping", `The ${field} column you chose is not in the file.`);
    picks[field] = at;
  }
  return build(headers, picks);
}
