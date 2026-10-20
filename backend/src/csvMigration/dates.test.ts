// Date parsing tests. Formats are the STATED ones (not checked against real exports). Never guesses a slash order silently.

import { describe, it, expect } from "vitest";
import { detectDateOrder, parsePlannedTime, isValidTimezone } from "./dates.js";

const NOW = new Date("2029-06-15T10:00:00.000Z");
const ok = (raw: string, o: Partial<Parameters<typeof parsePlannedTime>[1]> = {}) =>
  parsePlannedTime(raw, { dateOrder: null, timezone: "UTC", now: NOW, ...o });

describe("detectDateOrder", () => {
  it("is dmy when any first part is above 12", () => {
    expect(detectDateOrder(["17/05/2030 10:00", "01/02/2030 10:00"])).toBe("dmy");
  });
  it("is mdy when any second part is above 12", () => {
    expect(detectDateOrder(["05/17/2030 10:00", "01/02/2030 10:00"])).toBe("mdy");
  });
  it("is ambiguous when every part is 12 or less, and when the file contradicts itself", () => {
    expect(detectDateOrder(["01/02/2030 10:00", "03/04/2030 10:00"])).toBe("ambiguous");
    expect(detectDateOrder(["17/05/2030", "05/17/2030"])).toBe("ambiguous");
  });
  it("is not_applicable when there are no slash dates", () => {
    expect(detectDateOrder(["2030-05-17 10:00", "", "soon"])).toBe("not_applicable");
  });
});

describe("parsePlannedTime", () => {
  it("reads YYYY-MM-DD HH:mm in the given timezone", () => {
    expect(ok("2030-05-17 14:30")).toMatchObject({ ok: true, instant: "2030-05-17T14:30:00.000Z", plannedDate: "2030-05-17" });
    expect(ok("2030-05-17 14:30", { timezone: "Africa/Johannesburg" })).toMatchObject({ ok: true, instant: "2030-05-17T12:30:00.000Z", plannedDate: "2030-05-17" });
  });

  it("keeps the local calendar date for the planned date", () => {
    expect(ok("2030-05-17 01:00", { timezone: "Africa/Johannesburg" })).toMatchObject({ instant: "2030-05-16T23:00:00.000Z", plannedDate: "2030-05-17" });
  });

  it("reads ISO with a zone or offset, which wins over the request timezone", () => {
    expect(ok("2030-05-17T14:30:00Z", { timezone: "Africa/Johannesburg" })).toMatchObject({ instant: "2030-05-17T14:30:00.000Z" });
    expect(ok("2030-05-17T14:30:00+02:00")).toMatchObject({ instant: "2030-05-17T12:30:00.000Z" });
    expect(ok("2030-05-17T14:30")).toMatchObject({ instant: "2030-05-17T14:30:00.000Z" });
  });

  it("reads slash dates only with an explicit order", () => {
    expect(ok("17/05/2030 14:30", { dateOrder: "dmy" })).toMatchObject({ ok: true, plannedDate: "2030-05-17" });
    expect(ok("05/17/2030 14:30", { dateOrder: "mdy" })).toMatchObject({ ok: true, plannedDate: "2030-05-17" });
    expect(ok("01/02/2030 09:00", { dateOrder: "dmy" })).toMatchObject({ plannedDate: "2030-02-01" });
    expect(ok("01/02/2030 09:00", { dateOrder: "mdy" })).toMatchObject({ plannedDate: "2030-01-02" });
    expect(ok("01/02/2030 09:00")).toEqual({ ok: false, reason: "unparseable" });
  });

  it("treats a date without a time as that whole day", () => {
    expect(ok("2029-06-15")).toMatchObject({ ok: true, plannedDate: "2029-06-15" });
    expect(ok("2029-06-14")).toEqual({ ok: false, reason: "past" });
  });

  it("keeps no date for the past, for impossible dates, for text and for blanks", () => {
    expect(ok("2020-01-01 10:00")).toEqual({ ok: false, reason: "past" });
    expect(ok("2029-06-15 09:00")).toEqual({ ok: false, reason: "past" });
    expect(ok("2030-13-45 10:00")).toEqual({ ok: false, reason: "unparseable" });
    expect(ok("31/02/2030 10:00", { dateOrder: "dmy" })).toEqual({ ok: false, reason: "unparseable" });
    expect(ok("17/05/2030 10:00", { dateOrder: "mdy" })).toEqual({ ok: false, reason: "unparseable" });
    expect(ok("soon")).toEqual({ ok: false, reason: "unparseable" });
    expect(ok("   ")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA names and rejects anything else", () => {
    expect(isValidTimezone("Africa/Johannesburg")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Base")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("+02:00")).toBe(false);
  });
});
