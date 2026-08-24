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
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) return;
    const previous = link.getAttribute("href");
    link.setAttribute("href", `https://lazyrelay.com${path}`);
    return () => {
      if (previous !== null) link.setAttribute("href", previous);
    };
  }, [path]);
}
