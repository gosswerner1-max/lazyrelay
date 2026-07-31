// Two context-menu entries: one on any page (sends the page URL as a
// starting point for the post's content), one on any image (sends the
// image's direct URL so it can be dropped into the media field). Both just
// open lazyrelay.com with a query param — there's no extension-side auth
// flow here (that would need its own OAuth/API-key exchange, a real
// separate scope) so this only works when the customer already has a
// signed-in LazyRelay tab/session. If they're signed out, the dashboard
// simply won't see the prefill param and the extension has no way to know
// that happened — a real, documented limitation, not a silent failure by
// design choice.

const LAZYRELAY_URL = "https://lazyrelay.com/";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "lazyrelay-schedule-page",
    title: "Schedule this page with LazyRelay",
    contexts: ["page", "link"],
  });
  chrome.contextMenus.create({
    id: "lazyrelay-schedule-image",
    title: "Schedule this image with LazyRelay",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "lazyrelay-schedule-page") {
    const pageUrl = info.linkUrl ?? info.pageUrl;
    if (!pageUrl) return;
    chrome.tabs.create({ url: `${LAZYRELAY_URL}?prefillContent=${encodeURIComponent(pageUrl)}` });
  }
  if (info.menuItemId === "lazyrelay-schedule-image" && info.srcUrl) {
    chrome.tabs.create({ url: `${LAZYRELAY_URL}?prefillMediaUrl=${encodeURIComponent(info.srcUrl)}` });
  }
});
