// Working out who an escalated support-widget conversation actually came from.
//
// Pulled out of http/routes.ts so it can be tested without booting the app or
// calling the Anthropic API -- see src/test-support-chat.ts. Three separate
// defects landed in this logic on a single day (2026-08-17) precisely because
// it was only ever verifiable by pushing a real escalation through production,
// which costs a deploy and a row in the support inbox each time.

// Domain labels matched one at a time so a sentence-ending period can't be
// swallowed into the address ("...@example.com." must yield "@example.com").
// Also used in routes.ts to recognise the contact-details turn when picking
// question_summary.
export const SELF_REPORTED_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

const SELF_REPORTED_EMAIL_GLOBAL = new RegExp(SELF_REPORTED_EMAIL.source, "g");

// Our own addresses. A customer quoting one back at us is not a self-report.
// Covers the mail. subdomain too, since that's what the widget and the failure
// alerts actually send from (noreply@mail.lazyrelay.com).
const OWN_EMAIL_DOMAIN = /@(?:[\w-]+\.)*lazyrelay\.com$/i;

export type ChatTurn = { role: string; content: string };

/**
 * The address an anonymous visitor gave for themselves in this conversation,
 * if any. Returns undefined when nothing usable was offered.
 *
 * Only USER turns are searched. Found live 2026-08-17 (`support@` uid 33): the
 * previous version scanned the whole transcript including assistant turns, so
 * when the widget replied "please reach out to support@lazyrelay.com" that
 * address came back as the customer's own self-reported contact. An agent
 * trusting the header line would have emailed LazyRelay itself and recorded a
 * phantom lead. The same defect could attach an unrelated third party's
 * address to a customer record if the assistant ever quoted one.
 *
 * Our own domain is skipped even inside a user turn -- "I already emailed
 * support@lazyrelay.com" is a perfectly ordinary customer sentence and is not
 * a self-report either. A user turn carrying both ours and theirs yields
 * theirs.
 *
 * Anything else found is a LEAD TO VERIFY, never an authenticated identity:
 * the address is unverified by definition, and never gets account-specific or
 * billing information sent to it.
 */
export function extractSelfReportedEmail(messages: ChatTurn[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const [address] of message.content.matchAll(SELF_REPORTED_EMAIL_GLOBAL)) {
      if (!OWN_EMAIL_DOMAIN.test(address)) return address;
    }
  }
  return undefined;
}
