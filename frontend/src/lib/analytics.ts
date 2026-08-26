// Thin wrapper around the gtag.js snippet loaded in index.html (GA4
// property "LazyRelay", G-CNVBJ2076F). Kept as a real module rather than
// calling window.gtag directly everywhere so there's one place that
// tolerates gtag not being loaded yet (ad blockers, slow network) instead
// of every call site needing its own guard.

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

function track(eventName: string, params?: Record<string, unknown>): void {
  if (typeof window !== "undefined" && typeof window.gtag === "function") {
    window.gtag("event", eventName, params);
  }
}

/** Fired once a signup actually succeeds (Supabase returned no error) —
 *  this is the real conversion event Google Ads campaigns will be
 *  measured against, not a page view or button click. */
export function trackSignUp(): void {
  track("sign_up", { method: "email" });
}
