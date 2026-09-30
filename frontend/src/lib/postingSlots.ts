// Posting slots (backend 0100): times the customer likes to post, plus the
// "next free slot" helper the composer uses.

export interface PostingSlot {
  id: string;
  daysOfWeek: number[]; // ISO weekday, 1=Mon..7=Sun
  timeOfDay: string; // HH:MM
  timezone: string;
}

export interface PostingSlotList {
  maxSlots: number;
  slots: PostingSlot[];
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function describeSlot(s: Pick<PostingSlot, "daysOfWeek" | "timeOfDay" | "timezone">): string {
  const days = [...s.daysOfWeek].sort((a, b) => a - b);
  const label = days.length === 7 ? "Every day" : days.map((d) => DAY_NAMES[d - 1]).join(", ");
  return `${label} at ${s.timeOfDay} (${s.timezone})`;
}

/** An ISO instant as the local "YYYY-MM-DD" and "HH:MM" strings the date picker uses. */
export function isoToLocalDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}
