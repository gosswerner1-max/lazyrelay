// Runs third-party work (Google tag, directory badge scripts) after the browser's load event, when the
// main thread is idle, so it never delays the page's own load. Added 2026-10-16.
// Never use this for the consent default: that stays inline in index.html (its hash is in the CSP).

const IDLE_TIMEOUT_MS = 2000;
const FALLBACK_DELAY_MS = 200;

function whenIdle(cb: () => void) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => cb(), { timeout: IDLE_TIMEOUT_MS });
  } else {
    setTimeout(cb, FALLBACK_DELAY_MS);
  }
}

export function runAfterLoadAndIdle(cb: () => void) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    cb();
  };
  if (document.readyState === "complete") {
    whenIdle(once);
  } else {
    window.addEventListener("load", () => whenIdle(once), { once: true });
  }
}

const requested = new Set<string>();

export function loadScriptAfterLoad(src: string) {
  if (requested.has(src)) return;
  requested.add(src);
  runAfterLoadAndIdle(() => {
    const sc = document.createElement("script");
    sc.async = true;
    sc.src = src;
    document.head.appendChild(sc);
  });
}
