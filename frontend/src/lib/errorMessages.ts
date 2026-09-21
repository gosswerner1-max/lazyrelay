// Adapter errorMessage strings are written for logs/debugging (byte counts,
// raw platform API error text, HTTP status codes) -- never for a customer to
// read. Found live 2026-08-17: a real TikTok test upload surfaced
// "Video is 6213844 bytes -- single-chunk upload only supports files under
// 5242880 bytes" directly in the dashboard. This translates the common,
// recognizable failure shapes into plain language; anything unmatched falls
// back to a generic message rather than the raw string, with the original
// still available on request (never silently discarded -- useful for
// support/debugging, just not the default view).
// "6213844 bytes" -> "5.9MB" -- raw byte counts mean nothing to a customer,
// even in the "show technical details" fallback. Werner flagged this live
// 2026-08-17: the friendly message alone wasn't enough if the toggle right
// next to it still showed an unexplained number in bytes.
function bytesToMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Rewrites every standalone "N bytes"/"N byte" in a string to "X.XMB (N
// bytes)" -- keeps the exact original number for anyone who really wants
// it, but leads with the unit a person actually reads.
function annotateByteCounts(text: string): string {
  return text.replace(/(\d{3,})\s*bytes?\b/gi, (match, digits) => `${bytesToMB(Number(digits))} (${match})`);
}

// Pinterest's own two most common rejections, which a new account or a new
// website hits early: it blocks a link it thinks may be spam, and it caps how
// many pins one account may post in 24 hours. Raw text seen live from
// Pinterest: "Sorry! We blocked this link because it may lead to spam." and
// "maximum number of 10 posts for the last 24 hours for this account".
export const PINTEREST_BLOCKED_LINK_MESSAGE =
  "Pinterest blocked the link in this pin. This is a Pinterest decision about the website address, not something LazyRelay can change. You can ask Pinterest to review it in Pinterest's Help Center (Appeals, then Pinterest blocked my site). New websites are checked more closely, so start slowly and vary your captions.";
export const PINTEREST_DAILY_LIMIT_MESSAGE =
  "Pinterest limits how many pins one account can post in a day. Try again tomorrow, or spread your pins across more days.";

export function humanizeErrorMessage(raw: string | null, platform?: string): { friendly: string; technical: string | null } {
  if (!raw) return { friendly: "Something went wrong and no further detail was given.", technical: null };

  const platformLabel = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : "this platform";
  const lower = raw.toLowerCase();
  const technical = annotateByteCounts(raw);

  // Checked first, and matched on the raw text rather than on `platform`:
  // the wording is specific enough, and the daily-limit text contains "24"
  // and "posts" that the generic rate-limit rule below could otherwise claim.
  if (/blocked this link because it may lead to spam/.test(lower)) {
    return { friendly: PINTEREST_BLOCKED_LINK_MESSAGE, technical };
  }
  if (/maximum number of[\s\S]{0,60}posts?[\s\S]{0,60}24 hours/.test(lower)) {
    return { friendly: PINTEREST_DAILY_LIMIT_MESSAGE, technical };
  }

  if (/\bbytes?\b/.test(lower) && /(exceed|limit|too large|under \d)/.test(lower)) {
    // Pull the actual numbers out so the friendly line can say a real size
    // instead of just "too large" -- e.g. "This file is 5.9MB, but TikTok
    // only accepts files under 5.0MB here."
    const numbers = [...raw.matchAll(/(\d{3,})\s*bytes?\b/gi)].map((m) => Number(m[1]));
    const fileSize = numbers[0];
    const limit = numbers.find((n) => n !== fileSize);
    const sizeDetail =
      fileSize !== undefined && limit !== undefined
        ? `This file is ${bytesToMB(fileSize)}, but ${platformLabel} only accepts files under ${bytesToMB(limit)} here.`
        : `This file is too large for ${platformLabel}.`;
    return { friendly: `${sizeDetail} Try a smaller file or compress it.`, technical };
  }
  if (/token (has )?expired|invalid_token|invalid credentials|unauthorized/.test(lower)) {
    return { friendly: `This account's connection to ${platformLabel} needs to be refreshed. Try reconnecting it.`, technical };
  }
  if (/insufficient (scope|permission)|permission_denied|forbidden/.test(lower)) {
    return { friendly: `LazyRelay doesn't have permission to do this yet on your connected ${platformLabel} account. Try reconnecting it.`, technical };
  }
  if (/rate limit|too many requests|429/.test(lower)) {
    return { friendly: `${platformLabel} is temporarily limiting how many posts we can send. This will be retried automatically.`, technical };
  }
  if (/does not exist|not found|404/.test(lower)) {
    return { friendly: `The connected ${platformLabel} account or destination couldn't be found. It may have been removed or disconnected on ${platformLabel}'s side — try reconnecting.`, technical };
  }
  if (/does not support|not supported|doesn't support/.test(lower)) {
    return { friendly: `${platformLabel} doesn't support this type of post.`, technical };
  }

  return { friendly: `This post to ${platformLabel} didn't go through. Technical details are available below if you'd like them.`, technical };
}
