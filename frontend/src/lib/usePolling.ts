import { useEffect, useRef } from "react";

/** Calls `fn` every `ms` milliseconds while `enabled` and the page is visible. The refresh pattern for the inbox (the app has no
 *  websockets). It does not call at once: the caller loads first. Always calls the latest `fn`. */
export function usePolling(fn: () => void, ms: number, enabled: boolean): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      latest.current();
    }, ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
}
