// Rich-text "facets" for a Bluesky post. Bluesky only makes a link or a hashtag clickable when the post
// record says so: the text alone is not enough, and a link in the text is plain text without a facet.
// Full URLs and bare domains (lazyrelay.com) both get one; a bare domain links to its https:// address.
// A facet points at a BYTE range of the UTF-8 text (not a character range), so text with emoji or accents
// before the link needs real byte offsets. Mentions are left out on purpose: turning @name into a facet
// needs the person's DID, which means one extra lookup per mention.
// https://docs.bsky.app/docs/advanced-guides/post-richtext

export interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: "app.bsky.richtext.facet#link"; uri: string } | { $type: "app.bsky.richtext.facet#tag"; tag: string }>;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
// A bare domain such as lazyrelay.com or lazyrelay.com/pricing, which people type without https://. Only
// well-known endings count, so file names and code (node.js, install.sh, v1.2.3) are never turned into links.
// Left out on purpose: sh, so, to, in, cc, ws, im (too common in file names and ordinary words).
const BARE_TLDS = "com|net|org|io|co|app|dev|ai|me|info|biz|xyz|tech|online|site|store|blog|cloud|live|news|club|pro|us|uk|de|fr|nl|es|it|ca|au|nz|za|eu|tv|ly|gg|fm";
// Not preceded by a word character, @ . / : - or # (so not an email, a handle, a path or part of a longer address)
// and not followed by one (so lazyrelay.community or name.com@x.org are skipped).
const BARE_PATTERN = new RegExp(`(?<![\\w@./:#-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${BARE_TLDS})(?![\\w@-]|\\.[a-z0-9])(?:/[^\\s<>"']*)?`, "gi");
// A # that starts the text or follows whitespace, then the tag. Tags cannot hold spaces or these marks.
const TAG_PATTERN = /(^|\s)#([^\s#.,;:!?()[\]{}"'<>]+)/g;
const MAX_TAG_LENGTH = 64;

/** Drops the punctuation a sentence puts after a URL (a full stop, a comma, a closing bracket with no opening one). */
function trimUrl(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (last && ".,;:!?'\"".includes(last)) {
      out = out.slice(0, -1);
    } else if (last === ")" && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
      out = out.slice(0, -1);
    } else {
      return out;
    }
  }
}

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

export function buildBlueskyFacets(text: string): BlueskyFacet[] {
  const facets: BlueskyFacet[] = [];

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (!isValidUrl(url)) continue;
    const start = match.index ?? 0;
    const byteStart = byteLength(text.slice(0, start));
    facets.push({ index: { byteStart, byteEnd: byteStart + byteLength(url) }, features: [{ $type: "app.bsky.richtext.facet#link", uri: url }] });
  }

  for (const match of text.matchAll(BARE_PATTERN)) {
    const shown = trimUrl(match[0]);
    const uri = `https://${shown}`;
    if (!isValidUrl(uri)) continue;
    const byteStart = byteLength(text.slice(0, match.index ?? 0));
    const byteEnd = byteStart + byteLength(shown);
    if (facets.some((f) => byteStart < f.index.byteEnd && byteEnd > f.index.byteStart)) continue; // already part of a full URL
    facets.push({ index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#link", uri }] });
  }

  for (const match of text.matchAll(TAG_PATTERN)) {
    const tag = match[2];
    if (/^\d+$/.test(tag) || [...tag].length > MAX_TAG_LENGTH) continue; // a bare number is not a tag
    const hashStart = (match.index ?? 0) + match[1].length; // position of the #
    // Skip a hashtag that sits inside a URL already turned into a link (for example a #fragment).
    const byteStart = byteLength(text.slice(0, hashStart));
    const byteEnd = byteStart + byteLength("#" + tag);
    if (facets.some((f) => byteStart >= f.index.byteStart && byteStart < f.index.byteEnd)) continue;
    facets.push({ index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#tag", tag }] });
  }

  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}
