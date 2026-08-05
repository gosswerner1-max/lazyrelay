// Marketing Auditor — flag-only content quality check for LazyRelay's own
// promotional copy. Lighter bar than The Lazy Download's caption_qa_gate
// (no OCR/spellcheck pipeline — Marketing here is text-only content
// planning, no generated images/video in scope), but same "don't let
// obviously bad content through" spirit: no empty captions, no runaway
// length, always links back to lazyrelay.com, no overclaiming beyond
// what's actually true yet (e.g. "100% free forever" when pricing isn't
// finalized, or implying live platform posting that doesn't exist yet).

const fs = require("fs");

const MAX_CAPTION_LENGTH = 700;
const OVERCLAIM_PHRASES = ["100% free forever", "guaranteed", "instantly connect and post"];

function evaluateContentItem(item) {
  const reasons = [];
  const caption = item.caption ?? "";

  if (caption.trim().length === 0) reasons.push("empty caption");
  if (caption.length > MAX_CAPTION_LENGTH) reasons.push(`caption exceeds ${MAX_CAPTION_LENGTH} chars`);
  if (!item.link || !item.link.includes("lazyrelay.com")) reasons.push("missing or non-lazyrelay.com link");

  const lowerCaption = caption.toLowerCase();
  for (const phrase of OVERCLAIM_PHRASES) {
    if (lowerCaption.includes(phrase)) reasons.push(`overclaim phrase detected: "${phrase}"`);
  }

  return { flagged: reasons.length > 0, reasons };
}

function check(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const result = evaluateContentItem(fixture.item);
  const pass = result.flagged === fixture.expectFlagged;
  return {
    pass,
    reason: pass
      ? "ok"
      : `expected flagged=${fixture.expectFlagged}, got flagged=${result.flagged} (${result.reasons.join("; ") || "no reasons"})`,
  };
}

module.exports = { evaluateContentItem, check };
