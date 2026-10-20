// Reads the planned-time cells. Never guesses silently: a slash date needs an explicit day/month order, a time that is in the
// past or cannot be read is reported as "no usable date", and a zone written in the cell wins over the request timezone.

import { DateTime, IANAZone } from "luxon";

export type DateOrder = "dmy" | "mdy";
export type DetectedDateOrder = DateOrder | "ambiguous" | "not_applicable";

export type PlannedTime =
  | { ok: true; instant: string; plannedDate: string }
  | { ok: false; reason: "empty" | "unparseable" | "past" };

export interface ParseOptions {
  dateOrder: DateOrder | null;
  timezone: string;
  now: Date;
}

const SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export function isValidTimezone(name: string): boolean {
  return ZONE_NAME.test(name) && IANAZone.isValidZone(name);
}

/** Whether a file's slash dates are day-first, month-first, or cannot be told apart. */
export function detectDateOrder(values: string[]): DetectedDateOrder {
  let dayFirst = false;
  let monthFirst = false;
  let seen = false;
  for (const value of values) {
    const m = SLASH.exec(value.trim());
    if (!m) continue;
    seen = true;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  if (!seen) return "not_applicable";
  if (dayFirst && !monthFirst) return "dmy";
  if (monthFirst && !dayFirst) return "mdy";
  return "ambiguous";
}

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  hasTime: boolean;
  offset: string | null;
}

function readParts(raw: string, dateOrder: DateOrder | null): Parts | null {
  const iso = ISO.exec(raw);
  if (iso) {
    return { y: +iso[1], mo: +iso[2], d: +iso[3], h: +(iso[4] ?? 0), mi: +(iso[5] ?? 0), s: +(iso[6] ?? 0), hasTime: iso[4] !== undefined, offset: iso[7] ?? null };
  }
  const slash = SLASH.exec(raw);
  if (!slash || !dateOrder) return null;
  const [first, second] = [+slash[1], +slash[2]];
  const [d, mo] = dateOrder === "dmy" ? [first, second] : [second, first];
  return { y: +slash[3], mo, d, h: +(slash[4] ?? 0), mi: +(slash[5] ?? 0), s: +(slash[6] ?? 0), hasTime: slash[4] !== undefined, offset: null };
}

function toDateTime(p: Parts, timezone: string): DateTime {
  if (p.offset) {
    const off = p.offset.toUpperCase() === "Z" ? "Z" : p.offset.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    const stamp = `${String(p.y).padStart(4, "0")}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}T${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}:${String(p.s).padStart(2, "0")}${off}`;
    return DateTime.fromISO(stamp, { setZone: true });
  }
  return DateTime.fromObject({ year: p.y, month: p.mo, day: p.d, hour: p.h, minute: p.mi, second: p.s }, { zone: timezone });
}

export function parsePlannedTime(raw: string, options: ParseOptions): PlannedTime {
  const value = raw.trim();
  if (value === "") return { ok: false, reason: "empty" };
  const parts = readParts(value, options.dateOrder);
  if (!parts || parts.h > 23 || parts.mi > 59 || parts.s > 59) return { ok: false, reason: "unparseable" };
  const dt = toDateTime(parts, options.timezone);
  if (!dt.isValid) return { ok: false, reason: "unparseable" };
  const local = dt.setZone(options.timezone);
  const horizon = parts.hasTime ? dt : local.endOf("day");
  if (horizon.toMillis() <= options.now.getTime()) return { ok: false, reason: "past" };
  return { ok: true, instant: dt.toUTC().toISO() as string, plannedDate: local.toFormat("yyyy-MM-dd") };
}
