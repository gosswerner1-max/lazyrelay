// Turns an uploaded CSV into the list of drafts it would create, plus everything the person needs to check before agreeing.
// Pure: no database, no network, nothing stored. The same function backs the preview and the confirm step, so what is shown
// is exactly what is created.

import { createHash } from "node:crypto";
import { decodeCsvBuffer, parseCsvText, CsvMigrationError } from "./parseCsv.js";
import { resolveMapping, normalizeHeader, type ColumnChoice, type DetectedTool, type MappingOverride } from "./headerMap.js";
import { detectDateOrder, isValidTimezone, parsePlannedTime, type DateOrder, type DetectedDateOrder } from "./dates.js";
import { EXCERPT_CHARS, PREVIEW_ROW_LIMIT, SAMPLE_ROW_LIMIT } from "./limits.js";
import { MAX_DESTINATION_LINK_LENGTH, MAX_POST_CONTENT_LENGTH } from "../postCreation.js";
import { getPlatformRules } from "../platformRules.js";

export interface AnalyzeOptions {
  mapping?: MappingOverride;
  timezone?: string;
  dateOrder?: DateOrder;
  now?: Date;
}

export type SkipReason = "empty_text" | "duplicate" | "too_long" | "already_imported";

export interface ImportItem {
  /** The spreadsheet row number (the header is row 1). */
  row: number;
  text: string;
  link: string | null;
  /** What the draft will hold: the text, plus the link when the text does not already contain it. */
  content: string;
  plannedDate: string | null;
  plannedTime: string | null;
  issues: string[];
  /** Short tag that identifies this row of this file, so confirming twice never duplicates. */
  importTag: string;
}

export interface Analysis {
  detected: DetectedTool;
  columns: ColumnChoice;
  ignored: string[];
  needsMapping: boolean;
  headers: string[];
  sampleRows: string[][];
  fingerprint: string;
  rowsTotal: number;
  dateOrder: DetectedDateOrder;
  dateOrderRequired: boolean;
  timezone: string;
  items: ImportItem[];
  skipped: Array<{ row: number; reason: SkipReason }>;
  noUsableDate: number;
  warnings: string[];
  sourceTag: string;
}

const DEFAULT_TIMEZONE = "UTC";
const SAMPLE_CELL_CHARS = 200;

function shortestPlatformLimit(): { limit: number; label: string } | null {
  let best: { limit: number; label: string } | null = null;
  for (const rule of getPlatformRules()) {
    const max = rule.text.maxLength;
    if (max !== null && (best === null || max < best.limit)) best = { limit: max, label: rule.label };
  }
  return best;
}

function fingerprintOf(headers: string[], rows: string[][]): string {
  return createHash("sha256").update(JSON.stringify({ h: headers.map(normalizeHeader), r: rows })).digest("hex");
}

function cleanLink(raw: string): { link: string | null; issue: string | null } {
  const value = raw.trim();
  if (value === "") return { link: null, issue: null };
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && value.length <= MAX_DESTINATION_LINK_LENGTH) return { link: value, issue: null };
  } catch {
    // Not a web address: handled below, the same way as a wrong scheme.
  }
  return { link: null, issue: "Link ignored: it is not a web address starting with http or https." };
}

function importTagFor(fingerprint: string, row: number, content: string): string {
  return `ih-${createHash("sha256").update(`${fingerprint}:${row}:${content}`).digest("hex").slice(0, 16)}`;
}

interface Context {
  fingerprint: string;
  timezone: string;
  dateOrder: DateOrder | null;
  now: Date;
  limit: { limit: number; label: string } | null;
}

function itemFromRow(cells: { text: string; link: string; time: string }, row: number, ctx: Context): ImportItem | "too_long" {
  const text = cells.text.trim();
  const { link, issue } = cleanLink(cells.link);
  const content = link && !text.includes(link) ? `${text}\n\n${link}` : text;
  if (content.length > MAX_POST_CONTENT_LENGTH) return "too_long";
  const issues = issue ? [issue] : [];
  if (ctx.limit && content.length > ctx.limit.limit) {
    issues.push(`Longer than the ${ctx.limit.limit} character limit on ${ctx.limit.label}. It is kept as written; shorten it before scheduling there.`);
  }
  const planned = parsePlannedTime(cells.time, { dateOrder: ctx.dateOrder, timezone: ctx.timezone, now: ctx.now });
  if (!planned.ok && planned.reason !== "empty") issues.push(`No usable planned date (${planned.reason === "past" ? "it is in the past" : "it could not be read"}).`);
  return {
    row,
    text,
    link,
    content,
    plannedDate: planned.ok ? planned.plannedDate : null,
    plannedTime: planned.ok ? planned.instant : null,
    issues,
    importTag: importTagFor(ctx.fingerprint, row, content),
  };
}

function collectItems(rows: string[][], idx: { text: number; link: number; time: number }, ctx: Context) {
  const items: ImportItem[] = [];
  const skipped: Analysis["skipped"] = [];
  const seen = new Set<string>();
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "") : "");
  rows.forEach((r, n) => {
    const row = n + 2;
    const text = at(r, idx.text).trim();
    if (text === "") return void skipped.push({ row, reason: "empty_text" });
    const key = `${text.toLowerCase()}\u0001${at(r, idx.link).trim().toLowerCase()}`;
    if (seen.has(key)) return void skipped.push({ row, reason: "duplicate" });
    seen.add(key);
    const item = itemFromRow({ text, link: at(r, idx.link), time: at(r, idx.time) }, row, ctx);
    if (item === "too_long") skipped.push({ row, reason: "too_long" });
    else items.push(item);
  });
  return { items, skipped };
}

function sourceTagFor(detected: DetectedTool): string {
  return detected === "unknown" ? "import:csv" : `import:${detected}`;
}

function warningsFor(ignored: string[], required: boolean, hasTimeColumn: boolean): string[] {
  const out = ignored.map((h) => `Column "${h}" is ignored: media and account columns are never read or fetched.`);
  if (required) out.push("The dates could be day/month or month/day. Choose a date order to read them; until then they are treated as no usable date.");
  if (!hasTimeColumn) out.push("No planned time column was found. The drafts are created without a planned date.");
  if (hasTimeColumn) out.push("Planned dates are suggestions only. Every draft is created unscheduled.");
  return out;
}

export function analyzeCsv(buffer: Buffer, options: AnalyzeOptions = {}): Analysis {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) throw new CsvMigrationError(400, "invalid_timezone", "That timezone is not a valid IANA name, for example Africa/Johannesburg.");
  const parsed = parseCsvText(decodeCsvBuffer(buffer));
  const map = resolveMapping(parsed.headers, options.mapping);
  const fingerprint = fingerprintOf(parsed.headers, parsed.rows);
  const base = {
    detected: map.detected,
    columns: map.columns,
    ignored: map.ignored,
    needsMapping: map.needsMapping,
    headers: parsed.headers,
    sampleRows: parsed.rows.slice(0, SAMPLE_ROW_LIMIT).map((r) => r.map((c) => c.slice(0, SAMPLE_CELL_CHARS))),
    fingerprint,
    rowsTotal: parsed.rows.length,
    timezone,
    sourceTag: sourceTagFor(map.detected),
  };
  if (map.needsMapping) {
    return { ...base, dateOrder: "not_applicable", dateOrderRequired: false, items: [], skipped: [], noUsableDate: 0, warnings: [] };
  }
  const idx = {
    text: parsed.headers.indexOf(map.columns.text as string),
    link: map.columns.link === null ? -1 : parsed.headers.indexOf(map.columns.link),
    time: map.columns.time === null ? -1 : parsed.headers.indexOf(map.columns.time),
  };
  const dateOrder = detectDateOrder(idx.time < 0 ? [] : parsed.rows.map((r) => r[idx.time] ?? ""));
  const required = dateOrder === "ambiguous" && !options.dateOrder;
  const effective: DateOrder | null = dateOrder === "dmy" || dateOrder === "mdy" ? dateOrder : dateOrder === "ambiguous" ? (options.dateOrder ?? null) : null;
  const ctx: Context = { fingerprint, timezone, dateOrder: effective, now: options.now ?? new Date(), limit: shortestPlatformLimit() };
  const { items, skipped } = collectItems(parsed.rows, idx, ctx);
  return {
    ...base,
    dateOrder,
    dateOrderRequired: required,
    items,
    skipped,
    noUsableDate: items.filter((i) => i.plannedDate === null).length,
    warnings: warningsFor(map.ignored, required, idx.time >= 0),
  };
}

const excerpt = (text: string) => (text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text);

/** The preview answer: what was found, what would be created, what would be skipped. Creates nothing. */
export function buildPreview(a: Analysis) {
  const preview = {
    detected: a.detected,
    columns: a.columns,
    needsMapping: a.needsMapping,
    ignoredColumns: a.ignored,
    rowsTotal: a.rowsTotal,
    rowsUsable: a.items.length,
    noUsableDate: a.noUsableDate,
    rows: a.items.slice(0, PREVIEW_ROW_LIMIT).map((i) => ({ row: i.row, text: excerpt(i.text), link: i.link, plannedDate: i.plannedDate, plannedTime: i.plannedTime, issues: i.issues })),
    skipped: a.skipped,
    dateOrder: a.dateOrder,
    timezone: a.timezone,
    warnings: a.warnings,
    fileFingerprint: a.fingerprint,
  };
  return a.needsMapping ? { ...preview, headers: a.headers, sampleRows: a.sampleRows } : preview;
}
