// RSS-to-drafts (master list #18): a customer adds a feed URL; new items become
// DRAFTS (never posts) in their dashboard for them to review, edit and schedule.
// Everything read from a feed is untrusted data: this parser only pulls out a
// title, a link and an id, strips markup, and caps lengths. It never follows
// instructions in feed text and never posts anything.

export interface FeedItem {
  id: string; // guid / atom id, falling back to the link
  title: string;
  link: string;
}

const MAX_ITEMS = 25;
const MAX_TITLE = 300;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}
function safeChar(code: number): string {
  return code > 0 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
}

/** Text of the first <tag> in a block: unwraps CDATA, decodes entities, strips any markup, collapses whitespace. */
function tagText(block: string, tag: string): string {
  const m = new RegExp(String.raw`<${tag}(?:\s[^>]*)?>([\s\S]*?)</${tag}>`, "i").exec(block);
  if (!m) return "";
  let inner = m[1];
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  inner = cdata ? cdata[1] : decode(inner);
  // Decoded again after the tags are gone: html-type feed text is escaped twice.
  return decode(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** An Atom link: prefers rel="alternate" (or no rel), takes its href. */
function atomLink(block: string): string {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel\s*=\s*["']alternate["']/i.test(a)) ?? links.find((a) => !/rel\s*=/i.test(a)) ?? links[0];
  const href = pick ? /href\s*=\s*["']([^"']+)["']/i.exec(pick) : null;
  return href ? decode(href[1]).trim() : "";
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Parses RSS 2.0 and Atom text into at most 25 items, newest (first in the file) first. Returns [] for anything else. */
export function parseFeed(xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = tagText(block, "title").slice(0, MAX_TITLE);
    const isAtom = /^<entry\b/i.test(block);
    const link = isAtom ? atomLink(block) : tagText(block, "link");
    const id = (isAtom ? tagText(block, "id") : tagText(block, "guid")) || link;
    if (!title || !id) continue;
    items.push({ id: id.slice(0, 500), title, link: isHttpUrl(link) ? link : "" });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** The draft text for one item: title, then the link on its own line. */
export function draftTextFor(item: FeedItem): string {
  return item.link ? `${item.title}\n${item.link}` : item.title;
}
