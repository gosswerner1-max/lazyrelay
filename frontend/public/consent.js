// Shared Consent Mode v2 + cookie-banner bootstrap for LazyRelay's
// hand-authored static marketing/legal pages (frontend/public/*/index.html).
// Mirrors src/components/CookieConsent.tsx + the inline snippet in
// frontend/index.html so consent state is identical and shared (same
// localStorage key/shape) whether a visitor lands on the app or one of
// these static pages first.
//
// Found 2026-08-26: every static page loaded gtag.js and fired
// gtag('config', ...) completely unconditionally, with no default-denied
// Consent Mode and no banner at all -- the SPA got that treatment on
// 2026-08-25, these pages were missed, including /privacy and /terms
// themselves.
(function () {
  var GA_ID = "G-CNVBJ2076F";
  var STORAGE_KEY = "lazyrelay_cookie_consent";

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = window.gtag || gtag;

  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
    personalization_storage: "denied",
  });

  function applyConsent(choices) {
    gtag("consent", "update", {
      analytics_storage: choices.analytics ? "granted" : "denied",
      personalization_storage: choices.personalization ? "granted" : "denied",
      ad_storage: choices.targetedAdvertising ? "granted" : "denied",
      ad_user_data: choices.targetedAdvertising ? "granted" : "denied",
      ad_personalization: choices.targetedAdvertising ? "granted" : "denied",
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  }

  var stored = null;
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch (e) {
    localStorage.removeItem(STORAGE_KEY);
  }
  if (stored) applyConsent(stored);

  gtag("js", new Date());
  gtag("config", GA_ID);

  var gtagScript = document.createElement("script");
  gtagScript.async = true;
  gtagScript.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
  document.head.appendChild(gtagScript);

  if (stored) return;

  function renderBanner() {
    var el = document.createElement("div");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Cookie preferences");
    el.style.cssText =
      "position:fixed;bottom:20px;right:20px;width:320px;max-width:calc(100vw - 40px);" +
      "background:#fff;border:1px solid #e5e7eb;border-radius:10px;" +
      "box-shadow:0 8px 24px rgba(0,0,0,.18);padding:20px;z-index:1000;" +
      "font-size:13px;line-height:1.5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#5b6472;";
    el.innerHTML =
      '<button aria-label="Close" style="position:absolute;top:10px;right:10px;width:24px;height:24px;' +
      'border:1px solid #14171f;border-radius:4px;background:none;cursor:pointer;font-size:16px;line-height:1;color:#14171f;" ' +
      'data-consent-action="reject">&times;</button>' +
      '<p style="margin:0 0 10px;">This website uses cookies for analytics, personalization, and targeted ' +
      "advertising, in addition to what's essential for the site to work. You can accept or reject these, or " +
      "close this banner to continue with only essential cookies.</p>" +
      '<div style="margin:0 0 14px;"><a href="/privacy" style="color:#1a73e8;text-decoration:underline;">Privacy Policy</a></div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
      '<button data-consent-action="accept" style="background:#ff5630;color:#fff;border:none;border-radius:6px;padding:10px;font-weight:600;font-size:13px;cursor:pointer;">Accept All</button>' +
      '<button data-consent-action="reject" style="background:#14171f;color:#fff;border:none;border-radius:6px;padding:10px;font-weight:600;font-size:13px;cursor:pointer;">Reject Non-Essential</button>' +
      "</div>";
    document.body.appendChild(el);
    el.addEventListener("click", function (ev) {
      var action = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-consent-action");
      if (!action) return;
      applyConsent(
        action === "accept"
          ? { analytics: true, personalization: true, targetedAdvertising: true }
          : { analytics: false, personalization: false, targetedAdvertising: false }
      );
      el.remove();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderBanner);
  } else {
    renderBanner();
  }
})();
