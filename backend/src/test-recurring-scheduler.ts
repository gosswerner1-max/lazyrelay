/** Manual sanity check for computeOccurrencesInWindow() — the one genuinely
 *  tricky piece of the recurring-schedules feature (DST edges, wall-clock
 *  time correctness). No DB access, pure function only. Run with:
 *    npx tsx src/test-recurring-scheduler.ts
 */
import "dotenv/config";
import { DateTime } from "luxon";
import { computeOccurrencesInWindow } from "./recurringScheduler.js";

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures++;
  }
}

// 1. Basic case: Mon/Wed/Fri at 09:00 Africa/Johannesburg, starting from a
// known Monday, 7-day window should hit exactly 3 occurrences.
{
  console.log("Test 1: Mon/Wed/Fri 09:00 SAST, 7-day window from a Monday");
  const now = DateTime.fromISO("2026-08-03T06:00:00", { zone: "utc" }); // Monday, before 09:00 SAST (UTC+2)
  const occurrences = computeOccurrencesInWindow(
    { days_of_week: [1, 3, 5], time_of_day: "09:00:00", timezone: "Africa/Johannesburg", starts_on: "2026-01-01", ends_on: null },
    7,
    now,
  );
  check("exactly 3 occurrences", occurrences.length === 3);
  check("all at 09:00 local", occurrences.every((o) => o.hour === 9 && o.minute === 0));
  check("weekdays are Mon/Wed/Fri", occurrences.every((o) => [1, 3, 5].includes(o.weekday)));
}

// 2. DST transition — US Eastern spring-forward 2026-03-08. A 9am daily
// slot spanning the transition must stay at 9am local both sides, not drift
// to 8am or 10am UTC-equivalent.
{
  console.log("Test 2: daily 09:00 America/New_York across the 2026 spring-forward DST transition");
  const now = DateTime.fromISO("2026-03-06T00:00:00", { zone: "America/New_York" });
  const occurrences = computeOccurrencesInWindow(
    { days_of_week: [1, 2, 3, 4, 5, 6, 7], time_of_day: "09:00:00", timezone: "America/New_York", starts_on: "2026-01-01", ends_on: null },
    7,
    now,
  );
  check("all occurrences at 9am local regardless of DST", occurrences.every((o) => o.hour === 9));
  const utcHours = occurrences.map((o) => o.toUTC().hour);
  check("UTC hour shifts across the DST boundary (not constant)", new Set(utcHours).size > 1);
}

// 3. ends_on boundary — a slot that ends today should not generate tomorrow.
{
  console.log("Test 3: ends_on excludes occurrences after the end date");
  const now = DateTime.fromISO("2026-06-01T00:00:00", { zone: "utc" });
  const occurrences = computeOccurrencesInWindow(
    { days_of_week: [1, 2, 3, 4, 5, 6, 7], time_of_day: "09:00:00", timezone: "utc", starts_on: "2026-01-01", ends_on: "2026-06-02" },
    7,
    now,
  );
  check("no occurrence after ends_on", occurrences.every((o) => o.toISODate()! <= "2026-06-02"));
  check("at least one occurrence before the cutoff", occurrences.length > 0);
}

// 4. starts_on boundary — a slot that hasn't started yet generates nothing.
{
  console.log("Test 4: starts_on excludes occurrences before the start date");
  const now = DateTime.fromISO("2026-06-01T00:00:00", { zone: "utc" });
  const occurrences = computeOccurrencesInWindow(
    { days_of_week: [1, 2, 3, 4, 5, 6, 7], time_of_day: "09:00:00", timezone: "utc", starts_on: "2026-06-10", ends_on: null },
    7,
    now,
  );
  check("no occurrences before starts_on (window ends before start)", occurrences.length === 0);
}

// 5. Never generates anything already in the past relative to `now`.
{
  console.log("Test 5: never generates an occurrence before `now`");
  const now = DateTime.fromISO("2026-06-01T15:00:00", { zone: "utc" }); // after today's 09:00 slot
  const occurrences = computeOccurrencesInWindow(
    { days_of_week: [1, 2, 3, 4, 5, 6, 7], time_of_day: "09:00:00", timezone: "utc", starts_on: "2026-01-01", ends_on: null },
    7,
    now,
  );
  check("today's already-passed 09:00 slot is excluded", occurrences.every((o) => o >= now));
  check("still generates the remaining 6 days in the window", occurrences.length === 6);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
