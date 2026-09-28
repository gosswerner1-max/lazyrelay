// Launch-discount promo code capture (2026-09-28) -- first 100 customers,
// 20% off their first 3 months. Same last-touch, 30-day-window pattern as
// referral.ts (same file's own reasoning applies here too: localStorage
// over a cookie, no cross-subdomain need, no consent dependency). The
// actual discount (percentage, 3-cycle limit, 100-customer cap) all lives
// in Paddle's own discount object -- this module only has to get the code
// from the link the customer clicked to the checkout call they make later,
// possibly days apart.
const STORAGE_KEY = "lazyrelay_promo";
const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredPromo {
  code: string;
  capturedAt: number;
}

/** Reads `?promo=` from the given search string (pass window.location.search).
 *  Call once at module-evaluation time, same reasoning as referral.ts's
 *  readRefParam -- a later effect could run after something else has
 *  already rewritten the URL. */
export function readPromoParam(search: string): string | null {
  const code = new URLSearchParams(search).get("promo");
  if (!code) return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 && trimmed.length <= 40 ? trimmed : null;
}

/** Persists a freshly-seen promo code, overwriting any earlier one
 *  (last-touch). Safe to call on every page load -- a no-op when there's no
 *  `?promo=` param to capture. Wrapped in try/catch: losing promo
 *  attribution must never be the thing that breaks the app. */
export function capturePromoCode(promoCode: string | null): void {
  if (!promoCode) return;
  try {
    const record: StoredPromo = { code: promoCode, capturedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable -- attribution is lost for this visit, not fatal.
  }
}

/** Returns the stored promo code if one exists and is still within the
 *  30-day window, otherwise null. Read at the moment the customer actually
 *  starts a checkout (handleUpgrade in useDashboardState.tsx) -- the actual
 *  100-customer/3-month enforcement happens in Paddle itself, this window
 *  just governs how long the app keeps offering to apply it. */
export function getStoredPromoCode(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as StoredPromo;
    if (typeof record.code !== "string" || typeof record.capturedAt !== "number") return null;
    if (Date.now() - record.capturedAt > ATTRIBUTION_WINDOW_MS) return null;
    return record.code;
  } catch {
    return null;
  }
}
