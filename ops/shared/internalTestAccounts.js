// Shared exclusion list — accounts/subscriptions that must NEVER be treated
// as real customer candidates for an automated send, regardless of domain
// (accounts_ops.js or billing_ops.js). Added 2026-08-05 after billing went
// live in production and two real `accounts` rows turned out to be
// Werner's own testing (a synthetic `@lazyrelay.invalid` account, and his
// real `shop@lazydownloader.co.za` mailbox). Both are kept deliberately
// (testing is ongoing) rather than deleted, so the exclusion is a pattern
// match here instead — covers whatever test accounts get created next too.

const INTERNAL_TEST_EMAIL_PATTERNS = [/@lazyrelay\.invalid$/i, /@lazydownloader\.co\.za$/i, /@lazyrelay\.com$/i];

// Specific personal addresses confirmed 2026-08-05 as Werner's/Luzaan's own
// testing — a domain pattern can't cover these (real customers legitimately
// sign up with @gmail.com too), so this is an explicit, exact-match list.
// Confirmed with Werner: only these two exist right now. Add here, never
// widen the domain patterns above, if another personal test address shows
// up later.
const INTERNAL_TEST_EMAILS_EXACT = new Set(["goss.werner.1@gmail.com", "jacobsluzaan@gmail.com"]);

function isInternalTestAccount(email) {
  const normalized = (email ?? "").toLowerCase();
  if (INTERNAL_TEST_EMAILS_EXACT.has(normalized)) return true;
  return INTERNAL_TEST_EMAIL_PATTERNS.some((re) => re.test(normalized));
}

module.exports = { isInternalTestAccount, INTERNAL_TEST_EMAIL_PATTERNS, INTERNAL_TEST_EMAILS_EXACT };
