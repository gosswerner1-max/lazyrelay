import { describe, it, expect } from "vitest";
import { describeSlot, isoToLocalDateTime } from "./postingSlots";

describe("describeSlot", () => {
  it("lists the days in week order", () => {
    expect(describeSlot({ daysOfWeek: [5, 1, 3], timeOfDay: "09:00", timezone: "Africa/Johannesburg" })).toBe("Mon, Wed, Fri at 09:00 (Africa/Johannesburg)");
  });
  it("says every day for all seven", () => {
    expect(describeSlot({ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], timeOfDay: "18:30", timezone: "UTC" })).toBe("Every day at 18:30 (UTC)");
  });
});

describe("isoToLocalDateTime", () => {
  it("gives the local date and time strings the picker expects", () => {
    const d = new Date(2026, 9, 2, 9, 5); // local Oct 2, 09:05
    expect(isoToLocalDateTime(d.toISOString())).toEqual({ date: "2026-10-02", time: "09:05" });
  });
});
