// Backend port of ops/shared/internalTestAccounts.js — the shared list of
// accounts that must NEVER receive an automated customer email (test
// fixtures, Werner's and Luzaan's own addresses). Ported here because the
// deployed backend only contains backend/, so it cannot require() the ops
// folder. Added 2026-09-21 for the instant on-signup welcome email
// (signupWebhook.ts): sending to a synthetic @lazyrelay.invalid or
// @example.com fixture would bounce and dent the sending domain's reputation.
//
// KEEP IN SYNC with ops/shared/internalTestAccounts.js. There is a parity
// test (internalTestAccounts.test.ts) that fails if the two lists drift, so a
// change made in only one place is caught the next time tests run. See the
// ops file for the history behind each entry.

export const INTERNAL_TEST_EMAIL_PATTERNS: RegExp[] = [
  /@lazyrelay\.invalid$/i,
  /@lazydownloader\.co\.za$/i,
  /@lazyrelay\.com$/i,
  /@(?:[^@]+\.)?example\.(?:com|net|org)$/i,
  /@(?:[^@]+\.)?example$/i,
];

export const INTERNAL_TEST_EMAILS_EXACT = new Set<string>([
  "goss.werner.1@gmail.com",
  "jacobsluzaan@gmail.com",
  "lazyrelay+reviewer@gmail.com",
  "lazyrelay@gmail.com",
]);

function stripGmailAlias(email: string): string {
  const match = /^([^+]+)\+[^@]*(@gmail\.com)$/.exec(email);
  return match ? `${match[1]}${match[2]}` : email;
}

export function isInternalTestAccount(email: string | null | undefined): boolean {
  const normalized = (email ?? "").toLowerCase();
  if (INTERNAL_TEST_EMAILS_EXACT.has(normalized)) return true;
  if (INTERNAL_TEST_EMAILS_EXACT.has(stripGmailAlias(normalized))) return true;
  return INTERNAL_TEST_EMAIL_PATTERNS.some((re) => re.test(normalized));
}
