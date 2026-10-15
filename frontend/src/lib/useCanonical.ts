import { useEffect } from "react";

// Every SPA route (this app has no react-router — see App.tsx's manual
// view/path state machine) served the same hardcoded canonical from
// index.html, because nothing ever updated it client-side. Google Search
// Console flagged this: every one of these routes told Google "the real
// page is the homepage," which is only true for /pricing (same Landing
// component, just scrolled) — not for /dpa, /contact, /docs, /terms,
// /privacy, /data-deletion, /login, or /signup, which all render genuinely
// distinct content. Mirrors the document.title pattern these same page
// components already use: set on mount, restore on unmount.
export function useCanonical(path: string) {
  useNoindex(path);
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) return;
    const previous = link.getAttribute("href");
    link.setAttribute("href", `https://lazyrelay.com${path}/`);
    return () => {
      if (previous !== null) link.setAttribute("href", previous);
    };
  }, [path]);
}

// Client-only routes that must never be indexed. The SPA fallback serves the
// homepage HTML (canonical "/") for these, so without a robots meta Google
// sees them as duplicates of the homepage. "/dashboard" covers its sub-routes.
const NOINDEX_ROUTES = ["/login", "/signup", "/forgot-password", "/oauth/consent", "/dashboard"];

export function isNoindexPath(path: string): boolean {
  return NOINDEX_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}

// Adds <meta name="robots" content="noindex, nofollow"> on a noindex route and
// removes it again on unmount; on any other route clears a stale one.
export function useNoindex(path: string) {
  useEffect(() => {
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (!isNoindexPath(path)) {
      existing?.remove();
      return;
    }
    const meta = existing ?? document.createElement("meta");
    meta.setAttribute("name", "robots");
    meta.setAttribute("content", "noindex, nofollow");
    if (existing) return; // another noindex hook (e.g. OAuth consent embedding Login) owns it
    document.head.appendChild(meta);
    return () => meta.remove();
  }, [path]);
}
