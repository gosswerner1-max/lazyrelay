// Phone number normalisation for customer-uploaded WhatsApp broadcast contacts: any common written form in, E.164 out, or a
// fixed reason code. No external library (the repo has none); the country calling code comes from the table below.
//
// Rules:
//   - Allowed characters are digits, spaces, "-", ".", "(", ")" and a leading "+". Anything else is rejected.
//   - "+" or a leading "00" means international. A number with neither is read as digits that already include the country
//     code (the form Meta itself uses), EXCEPT a leading 0, which is a national number with no country code and is
//     rejected: guessing a country would message the wrong person.
//   - 8 to 15 digits (E.164 allows at most 15).
//   - A failure carries a reason code only, never the input.

export type PhoneResult =
  | { ok: true; e164: string; digits: string; countryCallingCode: string }
  | {
      ok: false;
      reason: "empty" | "invalid_characters" | "leading_zero_without_country_code" | "too_short" | "too_long" | "unknown_country_code";
    };

export const PHONE_MIN_DIGITS = 8;
export const PHONE_MAX_DIGITS = 15;

function range(from: number, to: number): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(String(n));
  return out;
}

// ITU-T E.164 country calling codes in use. Prefix-free by design, so the longest match is the only match.
const CALLING_CODES: ReadonlySet<string> = new Set([
  "1", "7",
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  ...range(51, 58), ...range(60, 66), "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98",
  "211", "212", "213", "216", "218", ...range(220, 258), ...range(260, 269), "290", "291", "297", "298", "299",
  ...range(350, 359), ...range(370, 389), "420", "421", "423", ...range(500, 509), ...range(590, 599),
  ...range(670, 692), "850", "852", "853", "855", "856", "880", "886", ...range(960, 968), ...range(970, 977),
  "992", "993", "994", "995", "996", "998",
]);

/** The country calling code at the start of these digits (longest match, 1 to 3 digits), or null. */
export function countryCallingCodeOf(digits: string): string | null {
  for (let len = 1; len <= 3; len++) {
    const prefix = digits.slice(0, len);
    if (CALLING_CODES.has(prefix)) return prefix;
  }
  return null;
}

export function normalizePhone(raw: unknown): PhoneResult {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (!/^\+?[0-9\s().-]+$/.test(text)) return { ok: false, reason: "invalid_characters" };

  let digits = text.replace(/\D/g, "");
  const international = text.startsWith("+") || digits.startsWith("00");
  if (!text.startsWith("+") && digits.startsWith("00")) digits = digits.slice(2);
  if (!international && digits.startsWith("0")) return { ok: false, reason: "leading_zero_without_country_code" };

  if (digits.length < PHONE_MIN_DIGITS) return { ok: false, reason: "too_short" };
  if (digits.length > PHONE_MAX_DIGITS) return { ok: false, reason: "too_long" };
  const countryCallingCode = countryCallingCodeOf(digits);
  if (!countryCallingCode) return { ok: false, reason: "unknown_country_code" };
  return { ok: true, e164: `+${digits}`, digits, countryCallingCode };
}
