// Marketing Operator — promotes LazyRelay itself for customer acquisition.
// DORMANT/RECOMMENDATION-ONLY: no LazyRelay-branded social accounts exist
// yet (confirmed 2026-07-22), so this queues content ideas to a pending
// file for human review — it never posts anywhere. Same shape as The Lazy
// Download's Etsy Ads domain before it went live.

const { StateStore } = require("../shared/stateStore.js");
const { evaluateContentItem } = require("../oversight/marketing_auditor.js");
const path = require("path");

function getStateStore() {
  return new StateStore(path.join(__dirname, "state", "pending_content.json"));
}

/**
 * Validates and queues content ideas for human review. Never posts live —
 * `live` always reports false here since no accounts exist to post to.
 * Each item: {platform, caption, link}.
 */
function queuePendingContent(items) {
  const store = getStateStore();
  const accepted = [];
  const rejected = [];

  for (const item of items) {
    const result = evaluateContentItem(item);
    if (result.flagged) {
      rejected.push({ item, reasons: result.reasons });
    } else {
      const key = `${item.platform}_${Date.now()}_${accepted.length}`;
      store.mark(key, { ...item, status: "pending_review", live: false });
      accepted.push(key);
    }
  }

  return { live: false, accepted, rejected, note: "DORMANT — no LazyRelay social accounts exist yet, nothing posts." };
}

function listPendingContent() {
  const store = getStateStore();
  return store.all();
}

module.exports = { queuePendingContent, listPendingContent };
