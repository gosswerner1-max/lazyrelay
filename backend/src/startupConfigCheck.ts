import { notifyOps } from "./notify.js";

/** Catches the two failure modes that silently broke LazyRelay in production
 *  for an unknown period before anyone noticed, both found and fixed
 *  2026-09-29: FRONTEND_URL missing entirely (app.ts's CORS allowlist falls
 *  back to localhost only, so every real browser request from lazyrelay.com
 *  gets rejected -- customers see a generic "Failed to fetch") and
 *  TIKTOK_CLIENT_KEY still pointing at the Sandbox app's key (TikTok's own
 *  "sb" prefix) eight days after the Production app was approved on
 *  2026-09-21. Both sat unnoticed because everything ALREADY connected kept
 *  working -- only a brand-new browser session or a brand-new TikTok
 *  connect attempt ever hit them. The existing startup log (see index.ts)
 *  only ever checked "set" vs "MISSING", never whether the value was
 *  actually the right one -- this checks the two known-dangerous cases and
 *  raises them through the same notifyOps() alert path the incident
 *  responder already watches, so config drift like this surfaces in
 *  minutes instead of days.
 *
 *  Gated on RENDER (set automatically by Render on every deployed service)
 *  so local dev boots, which never set these the same way, stay quiet. */
export async function checkProductionConfig(): Promise<void> {
  if (process.env.RENDER !== "true") return;

  if (!process.env.FRONTEND_URL) {
    await notifyOps(
      "FRONTEND_URL is not set on this deploy. The CORS allowlist falls back to http://localhost:5173 only -- every real browser request from lazyrelay.com/www.lazyrelay.com will be rejected (customers see \"Failed to fetch\"). Set FRONTEND_URL=https://lazyrelay.com in Render's environment.",
    );
  }

  if (process.env.TIKTOK_CLIENT_KEY?.startsWith("sb")) {
    await notifyOps(
      'TIKTOK_CLIENT_KEY looks like a Sandbox app key (TikTok\'s own "sb" prefix), not the Production key. Any TikTok account not manually added as a sandbox target user will fail to connect with error_type=non_sandbox_target. Check the app\'s Production tab at developers.tiktok.com and update TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET in Render if this is wrong.',
    );
  }
}
