// GET /r/:code — the public redirect behind every tracked link. Mounted at the app root (not under /api) so the address stays short.
// Rules: the visitor always ends up on one of our pages (never an error), only real people are counted, and the database is told nothing
// personal: just the code and whether to count (see src/trackedLinks.ts and migration 0146). Raw click volume only: no visitor identifier of any kind.

import { Router, type NextFunction, type Request, type Response } from "express";
import { supabase } from "../supabase.js";
import { redirectRateLimit } from "./rateLimit.js";
import { CODE_RE, HOME_URL, isBotUserAgent, parseDestination } from "../trackedLinks.js";

/** How long a visitor waits for the counter before being sent to the home page. */
export const RPC_TIMEOUT_MS = 2500;

export function buildTrackedLinkRedirectRouter(): Router {
  const router = Router();

  router.get("/r/:code", redirectRateLimit, async (req, res) => {
    // Never cached: a cached redirect would skip the counter on every later visit.
    res.set("Cache-Control", "no-store");
    const code = typeof req.params.code === "string" ? req.params.code : "";
    if (!CODE_RE.test(code)) {
      res.redirect(302, HOME_URL);
      return;
    }
    const ua = req.get("user-agent") ?? "";
    const count = req.method !== "HEAD" && !isBotUserAgent(ua);
    try {
      const call = Promise.resolve(supabase.rpc("record_link_click", { p_code: code, p_count: count }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), RPC_TIMEOUT_MS);
      });
      const result = await Promise.race([call, timeout]).finally(() => clearTimeout(timer));
      if (!result) {
        console.error("GET /r/:code: counter did not answer in time");
        res.redirect(302, HOME_URL);
        return;
      }
      const { data, error } = result;
      if (error) {
        console.error("GET /r/:code:", error.message);
        res.redirect(302, HOME_URL);
        return;
      }
      // Second check on the way out, even though the database already refuses anything else: this route must never become an open redirect.
      res.redirect(302, parseDestination(data) ?? HOME_URL);
    } catch (err) {
      console.error("GET /r/:code:", err instanceof Error ? err.message : err);
      res.redirect(302, HOME_URL);
    }
  });

  // A code with broken percent-encoding (for example /r/%zz) fails inside Express before the handler runs. A visitor still goes home, never to an error.
  router.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.set("Cache-Control", "no-store");
    res.redirect(302, HOME_URL);
  });

  return router;
}
