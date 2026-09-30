import { describe, it, expect } from "vitest";
import { nextFreeSlot, slotOccurrences, isValidTimeOfDay } from "./postingSlots.js";

const JHB = "Africa/Johannesburg"; // UTC+2, no DST
const monWedFri = { daysOfWeek: [1, 3, 5], timeOfDay: "09:00", timezone: JHB };
// Wed 2026-09-30 08:00 UTC = 10:00 in Johannesburg (after that day's 09:00 slot)
const now = new Date("2026-09-30T08:00:00Z");

describe("nextFreeSlot", () => {
  it("picks the next slot in the future, in the slot's own timezone", () => {
    // Today's 09:00 JHB (07:00 UTC) has passed, so Friday 09:00 JHB = 07:00 UTC.
    expect(nextFreeSlot([monWedFri], [], now)?.toISOString()).toBe("2026-10-02T07:00:00.000Z");
  });

  it("skips slots already taken on the channel", () => {
    const taken = [new Date("2026-10-02T07:00:00Z")];
    expect(nextFreeSlot([monWedFri], taken, now)?.toISOString()).toBe("2026-10-05T07:00:00.000Z");
  });

  it("treats a post within the same minute as the same slot", () => {
    const taken = [new Date("2026-10-02T07:00:20Z")];
    expect(nextFreeSlot([monWedFri], taken, now)?.toISOString()).toBe("2026-10-05T07:00:00.000Z");
  });

  it("merges several slots and picks the earliest free one", () => {
    const evening = { daysOfWeek: [3], timeOfDay: "18:30", timezone: JHB };
    expect(nextFreeSlot([monWedFri, evening], [], now)?.toISOString()).toBe("2026-09-30T16:30:00.000Z");
  });

  it("never returns a time in the past or right now", () => {
    const at = new Date("2026-09-30T07:00:00Z"); // exactly the slot time
    expect(nextFreeSlot([monWedFri], [], at)?.toISOString()).toBe("2026-10-02T07:00:00.000Z");
  });

  it("returns null with no slots, or when every slot in the horizon is taken", () => {
    expect(nextFreeSlot([], [], now)).toBeNull();
    const all = slotOccurrences([monWedFri], now);
    expect(nextFreeSlot([monWedFri], all, now)).toBeNull();
  });

  it("ignores a slot with a bad time or timezone", () => {
    expect(nextFreeSlot([{ daysOfWeek: [1], timeOfDay: "25:00", timezone: JHB }], [], now)).toBeNull();
    expect(nextFreeSlot([{ daysOfWeek: [1], timeOfDay: "09:00", timezone: "Not/AZone" }], [], now)).toBeNull();
  });
});

describe("isValidTimeOfDay", () => {
  it("accepts HH:MM only", () => {
    expect(isValidTimeOfDay("09:00")).toBe(true);
    expect(isValidTimeOfDay("9:00")).toBe(false);
    expect(isValidTimeOfDay("24:00")).toBe(false);
  });
});
