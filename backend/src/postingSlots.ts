import { DateTime } from "luxon";

// Posting slots (2026-09-30, master list #13): a customer names the times they
// like to post (e.g. Mon/Wed/Fri 09:00). "Next free slot" is the first slot in
// the future that no post on the same channel already occupies. This only
// PICKS a time; the post itself is scheduled through the normal routes, so all
// the usual checks (limits, warm-up, media rules) still run.

export interface PostingSlot {
  daysOfWeek: number[]; // ISO weekday, 1=Mon..7=Sun
  timeOfDay: string; // "HH:MM" 24h
  timezone: string; // IANA name
}

const HORIZON_DAYS = 60;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeOfDay(v: string): boolean {
  return TIME_RE.test(v);
}

/** Every slot occurrence between now and the horizon, soonest first. */
export function slotOccurrences(slots: PostingSlot[], now: Date, horizonDays = HORIZON_DAYS): Date[] {
  const out: Date[] = [];
  const end = now.getTime() + horizonDays * 86_400_000;
  for (const slot of slots) {
    const m = TIME_RE.exec(slot.timeOfDay);
    if (!m) continue;
    const zoneNow = DateTime.fromJSDate(now, { zone: slot.timezone });
    if (!zoneNow.isValid) continue;
    for (let d = 0; d <= horizonDays + 1; d++) {
      const day = zoneNow.plus({ days: d });
      if (!slot.daysOfWeek.includes(day.weekday)) continue;
      const at = day.set({ hour: Number(m[1]), minute: Number(m[2]), second: 0, millisecond: 0 });
      const ms = at.toMillis();
      if (at.isValid && ms > now.getTime() && ms <= end) out.push(new Date(ms));
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The first slot occurrence that is strictly in the future and not already taken.
 * `taken` are the scheduled times already used on this channel; two posts within a
 * minute of each other count as the same slot.
 */
export function nextFreeSlot(slots: PostingSlot[], taken: Date[], now: Date = new Date()): Date | null {
  const used = new Set(taken.map((t) => Math.floor(t.getTime() / 60_000)));
  for (const at of slotOccurrences(slots, now)) {
    if (!used.has(Math.floor(at.getTime() / 60_000))) return at;
  }
  return null;
}
