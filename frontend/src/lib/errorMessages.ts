// Adapter errorMessage strings are written for logs/debugging (byte counts,
// raw platform API error text, HTTP status codes) -- never for a customer to
// read. Found live 2026-08-17: a real TikTok test upload surfaced
// "Video is 6213844 bytes -- single-chunk upload only supports files under
// 5242880 bytes" directly in the dashboard. This translates the common,
// recognizable failure shapes into plain language; anything unmatched falls
// back to a generic message rather than the raw string, with the original
// still available on request (never silently discarded -- useful for
// support/debugging, just not the default view).
export function humanizeErrorMessage(raw: string | null, platform?: string): { friendly: string; technical: string | null } {
  if (!raw) return { friendly: "Something went wrong and no further detail was given.", technical: null };

  const platformLabel = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : "this platform";
  const lower = raw.toLowerCase();

  if (/\bbytes?\b/.test(lower) && /(exceed|limit|too large|under \d)/.test(lower)) {
    return { friendly: `This file is too large for ${platformLabel}. Try a smaller file or compress it.`, technical: raw };
  }
  if (/token (has )?expired|invalid_token|invalid credentials|unauthorized/.test(lower)) {
    return { friendly: `This account's connection to ${platformLabel} needs to be refreshed. Try reconnecting it.`, technical: raw };
  }
  if (/insufficient (scope|permission)|permission_denied|forbidden/.test(lower)) {
    return { friendly: `LazyRelay doesn't have permission to do this yet on your connected ${platformLabel} account. Try reconnecting it.`, technical: raw };
  }
  if (/rate limit|too many requests|429/.test(lower)) {
    return { friendly: `${platformLabel} is temporarily limiting how many posts we can send. This will be retried automatically.`, technical: raw };
  }
  if (/does not exist|not found|404/.test(lower)) {
    return { friendly: `The connected ${platformLabel} account or destination couldn't be found. It may have been removed or disconnected on ${platformLabel}'s side — try reconnecting.`, technical: raw };
  }
  if (/does not support|not supported|doesn't support/.test(lower)) {
    return { friendly: `${platformLabel} doesn't support this type of post.`, technical: raw };
  }

  return { friendly: `This post to ${platformLabel} didn't go through. Technical details are available below if you'd like them.`, technical: raw };
}
