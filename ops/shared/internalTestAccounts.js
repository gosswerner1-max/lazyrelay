// Shared exclusion list — accounts/subscriptions that must NEVER be treated
// as real customer candidates for an automated send, regardless of domain
// (accounts_ops.js or billing_ops.js). Added 2026-08-05 after billing went
// live in production and two real `accounts` rows turned out to be
// Werner's own testing (a synthetic `@lazyrelay.invalid` account, and his
// real `shop@lazydownloader.co.za` mailbox). Both are kept deliberately
// (testing is ongoing) rather than deleted, so the exclusion is a pattern
// match here instead — covers whatever test accounts get created next too.

const INTERNAL_TEST_EMAIL_PATTERNS = [
  /@lazyrelay\.invalid$/i,
  /@lazydownloader\.co\.za$/i,
  /@lazyrelay\.com$/i,
  // RFC 2606 reserved-for-documentation domains. Added 2026-08-31 (Werner's
  // go-ahead) after `lazyrelay-disposable-onboarding-test@example.com` -- the
  // onboarding-popup test fixture created 2026-08-30 via the Supabase Admin
  // API -- slipped through as a "genuine external signup" and was 6 days from
  // being sent a stuck-onboarding nudge by lazyrelay-accounts-ops-daily.
  // Fourth instance of a fixture beating this filter (Google reviewer,
  // +lrtest1, the gmail login change, then this); the first three were
  // address-shaped and fixed with exact entries + stripGmailAlias(), this one
  // is domain-shaped and needed a pattern. Safe to widen rather than list
  // exactly -- unlike @gmail.com, these domains are reserved by RFC 2606
  // precisely so they can never be registered or receive mail, so no real
  // customer can ever sign up on one. Subdomains included (mail.example.com).
  /@(?:[^@]+\.)?example\.(?:com|net|org)$/i,
  // The reserved `.example` TLD from the same RFC clause, same rationale.
  /@(?:[^@]+\.)?example$/i,
];

// Specific personal addresses confirmed 2026-08-05 as Werner's/Luzaan's own
// testing — a domain pattern can't cover these (real customers legitimately
// sign up with @gmail.com too), so this is an explicit, exact-match list.
// Confirmed with Werner: only these two exist right now. Add here, never
// widen the domain patterns above, if another personal test address shows
// up later.
//   Scope of that rule, clarified 2026-08-31: it means never widen a
//   *deliverable* domain (@gmail.com and the like) where a real customer
//   could collide. It does not cover the RFC 2606 reserved domains added to
//   the pattern list above, which no one can ever register or receive mail
//   on -- those are safe as patterns and belong there, not here.
const INTERNAL_TEST_EMAILS_EXACT = new Set([
  "goss.werner.1@gmail.com",
  "jacobsluzaan@gmail.com",
  "lazyrelay+reviewer@gmail.com", // Google OAuth reviewer test account, confirmed 2026-08-15
  // The dogfooding account's login (2026-08-30, was shop@lazydownloader.co.za
  // until the calendar-sync test needed it to match a real Google login).
  // Same account this whole file's header comment already describes -- just
  // a different email for it now, not a new test account.
  "lazyrelay@gmail.com",
]);

// Gmail-only: a "+alias" (local-part+anything@gmail.com) is the same real
// inbox as local-part@gmail.com. Found 2026-08-21 when a real test signup
// (goss.werner.1+lrtest1@gmail.com, used to verify the confirmation-link
// auto-sign-in flow) wasn't recognized as internal and was queued for a
// stuck-onboarding nudge to Werner's own inbox. Checked against both the
// raw and de-aliased form (not just de-aliased) so a literal aliased
// address already in the exact list — lazyrelay+reviewer@gmail.com, a
// specific Google-controlled address, not a base Werner types — still
// matches only itself and isn't accidentally widened to unrelated aliases
// of the same base (this no longer means bare lazyrelay@gmail.com is safe
// to omit, since 2026-08-30 it's in the exact list directly).
function stripGmailAlias(email) {
  const match = /^([^+]+)\+[^@]*(@gmail\.com)$/.exec(email);
  return match ? `${match[1]}${match[2]}` : email;
}

function isInternalTestAccount(email) {
  const normalized = (email ?? "").toLowerCase();
  if (INTERNAL_TEST_EMAILS_EXACT.has(normalized)) return true;
  if (INTERNAL_TEST_EMAILS_EXACT.has(stripGmailAlias(normalized))) return true;
  return INTERNAL_TEST_EMAIL_PATTERNS.some((re) => re.test(normalized));
}

module.exports = { isInternalTestAccount, INTERNAL_TEST_EMAIL_PATTERNS, INTERNAL_TEST_EMAILS_EXACT };
