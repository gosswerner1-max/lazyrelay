// E.164 normalisation for customer-uploaded WhatsApp contacts. Pure, no network, no libraries.
import { describe, it, expect } from "vitest";
import { normalizePhone } from "./phone.js";

describe("normalizePhone", () => {
  it("normalises common written forms to E.164 and derives the country calling code", () => {
    expect(normalizePhone("+27 82 123 4567")).toEqual({ ok: true, e164: "+27821234567", digits: "27821234567", countryCallingCode: "27" });
    expect(normalizePhone("+44 (20) 7946-0958")).toMatchObject({ ok: true, e164: "+442079460958", countryCallingCode: "44" });
    expect(normalizePhone("0027821234567")).toMatchObject({ ok: true, e164: "+27821234567", countryCallingCode: "27" });
    expect(normalizePhone("27821234567")).toMatchObject({ ok: true, e164: "+27821234567" });
    expect(normalizePhone("+971 50 123 4567")).toMatchObject({ ok: true, countryCallingCode: "971" });
    expect(normalizePhone("+7 912 345 6789")).toMatchObject({ ok: true, countryCallingCode: "7" });
    expect(normalizePhone("+1 415.555.2671")).toMatchObject({ ok: true, countryCallingCode: "1" });
  });

  it("rejects a national number with a leading 0 and no country code", () => {
    expect(normalizePhone("0821234567")).toEqual({ ok: false, reason: "leading_zero_without_country_code" });
    expect(normalizePhone("082 123 4567")).toEqual({ ok: false, reason: "leading_zero_without_country_code" });
  });

  it("rejects numbers that are too short or too long", () => {
    expect(normalizePhone("+27 82 12")).toEqual({ ok: false, reason: "too_short" });
    expect(normalizePhone("+1234567890123456")).toEqual({ ok: false, reason: "too_long" });
  });

  it("rejects letters, empty input, non-strings and unknown country codes", () => {
    expect(normalizePhone("+27 82 abc 4567")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(normalizePhone("")).toEqual({ ok: false, reason: "empty" });
    expect(normalizePhone("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizePhone(undefined)).toEqual({ ok: false, reason: "empty" });
    expect(normalizePhone(27821234567)).toEqual({ ok: false, reason: "empty" });
    expect(normalizePhone("+999 123 456 789")).toEqual({ ok: false, reason: "unknown_country_code" });
    expect(normalizePhone("+0 123 456 789")).toEqual({ ok: false, reason: "unknown_country_code" });
  });

  it("never echoes the input back in a failure", () => {
    expect(JSON.stringify(normalizePhone("0821234567"))).not.toMatch(/\d{7}/);
  });
});
