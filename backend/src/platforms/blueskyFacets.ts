// Rich-text "facets" for a Bluesky post. Bluesky only makes a link or a hashtag clickable when the post
// record says so: the text alone is not enough, and the official app shows a bare URL as plain text.
// A facet points at a BYTE range of the UTF-8 text (not a character range), so text with emoji or accents
// before the link needs real byte offsets. Mentions are left out on purpose: turning @name into a facet
// needs the person's DID, which means one extra lookup per mention.
// https://docs.bsky.app/docs/advanced-guides/post-richtext

export interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: "app.bsky.richtext.facet#link"; uri: string } | { $type: "app.bsky.richtext.facet#tag"; tag: string }>;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
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
