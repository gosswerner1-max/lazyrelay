// Opt-out keywords for inbound WhatsApp text. Meta sets no STOP-keyword rule; this is LazyRelay's own, deliberately narrow:
// the WHOLE message (after trimming, dropping trailing punctuation and upper-casing) must be one of the keywords below, and
// at most 20 characters. "don't stop", "stop the car" and "I want to cancel my order" are ordinary sentences and never match.

export const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPT OUT", "OPTOUT", "STOP ALL"]);
export const OPT_OUT_MAX_LENGTH = 20;

/** The canonical keyword for this message, or null when it is not an opt-out keyword. */
export function optOutKeywordOf(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const normalised = body.trim().replace(/[\s.!?,;:]+$/u, "").replace(/\s+/g, " ").toUpperCase();
  if (normalised === "" || normalised.length > OPT_OUT_MAX_LENGTH) return null;
  return OPT_OUT_KEYWORDS.has(normalised) ? normalised : null;
}

export function isOptOutKeyword(body: unknown): boolean {
  return optOutKeywordOf(body) !== null;
}
