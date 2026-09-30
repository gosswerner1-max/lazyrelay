// Where a signed-in visitor should be moved to so the dashboard lives at
// /dashboard (see App.tsx). Returns the URL to replace the address bar with,
// or null when the current URL should be left alone.
//
// The query string MUST be carried across. The connect flows send the customer
// back to "/?selectAccount=...", "/?connected=1", "/?connectError=..." and the
// browser extension opens "/?prefillContent=...". The Dashboard is lazy-loaded
// and reads those params once when its chunk loads, which is after this
// redirect has run. Dropping the query string here (as this used to) made the
// dashboard load with no params, so the Page/account picker, the connect
// confirmation and the "Account connected!" notice never appeared
// (found 2026-09-30, when the new connect confirmation did not show).

// Pages a signed-in visitor must never be redirected away from.
// "/review/" (client review links) was missing until 2026-09-30: a signed-in visitor, including an owner
// previewing their own link, was bounced to the dashboard. Found by opening a link in a real browser.
const EXEMPT_PREFIXES = ["/connect/", "/bio/", "/verify/", "/feedback/", "/review/"];
const EXEMPT_PATHS = ["/oauth/consent", "/team/accept", "/docs", "/reset-password"];

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function dashboardRedirectTarget(pathname: string, search: string): string | null {
  if (EXEMPT_PREFIXES.some((p) => pathname.startsWith(p)) || EXEMPT_PATHS.includes(pathname)) return null;
  if (normalizePath(pathname) === "/dashboard") return null;
  return "/dashboard" + search;
}
