// Referral-code capture for the v1 partner program (2026-09-02). Last-touch,
// 30-day attribution per the spec (project-referral-program-spec-2026-09-02.md
// in werner-brain): a fresh `?ref=` overwrites any previously stored code,
// and a stored code older than 30 days is treated as expired. Stored in
// localStorage rather than a cookie -- this is a single-domain app with no
// need for the code to survive a cross-subdomain redirect, and localStorage
// avoids pulling in a cookie-consent dependency for a non-essential feature.
const STORAGE_KEY = "lazyrelay_ref";
const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredReferral {
  code: string;
  capturedAt: number;
}

/** Reads `?ref=` from the given search string (pass window.location.search).
 *  Call once at module-evaluation time, same reasoning as App.tsx's own
 *  INITIAL_PATH -- a later effect could run after something else has
 *  already rewritten the URL. */
export function readRefParam(search: string): string | null {
  const code = new URLSearchParams(search).get("ref");
  if (!code) return null;
  const trimmed = code.trim().toLowerCase();
  return trimmed.length > 0 && trimmed.length <= 40 ? trimmed : null;
}

/** Persists a freshly-seen ref code, overwriting any earlier one
 *  (last-touch). Safe to call on every page load -- a no-op when there's no
 *  `?ref=` param to capture. Wrapped in try/catch: localStorage can throw in
 *  a private-browsing context or when storage is full, and losing referral
 *  attribution must never be the thing that breaks the app. */
export function captureReferralCode(refCode: string | null): void {
  if (!refCode) return;
  try {
    const record: StoredReferral = { code: refCode, capturedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable -- attribution is lost for this visit, not fatal.
  }
}

/** Returns the stored referral code if one exists and is still within the
 *  30-day attribution window, otherwise null. Read at signup time
 *  (AuthContext.tsx) to thread into Supabase's user metadata. */
export function getStoredReferralCode(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as StoredReferral;
    if (typeof record.code !== "string" || typeof record.capturedAt !== "number") return null;
    if (Date.now() - record.capturedAt > ATTRIBUTION_WINDOW_MS) return null;
    return record.code;
  } catch {
    return null;
  }
}

/** Reads the optional channel word from a partner link (`utm_content`, for example "youtube"). Same shape rules as the database
 *  accepts: 1 to 30 lowercase letters, numbers, - or _. Anything else is ignored. */
export function readChannelParam(search: string): string | null {
  const v = new URLSearchParams(search).get("utm_content");
  if (!v) return null;
  const t = v.trim().toLowerCase();
  return /^[a-z0-9_-]{1,30}$/.test(t) ? t : null;
}

const CLICK_SESSION_KEY = "lazyrelay_ref_click_counted";

/** Counts one open of a partner's link, anonymously (2026-10-08). Sends only the code and the channel word: no cookie, no visitor id, no
 *  IP address is stored (the server adds 1 to a per-day counter). Once per browser tab session per code, remembered in sessionStorage,
 *  which is cleared when the tab closes and is not a cookie. Failures are ignored: counting must never break a page. */
export function reportReferralClick(refCode: string | null, channel: string | null): void {
  if (!refCode) return;
  try {
    if (sessionStorage.getItem(CLICK_SESSION_KEY) === refCode) return;
    sessionStorage.setItem(CLICK_SESSION_KEY, refCode);
  } catch {
    // sessionStorage unavailable: count anyway (a repeat count is better than none).
  }
  try {
    void fetch(`${import.meta.env.VITE_API_URL}/public/referral/click`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: refCode, channel: channel ?? "" }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // ignore
  }
}
