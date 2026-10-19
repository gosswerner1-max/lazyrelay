// Short-lived session tokens for a companion service, so the signed-in dashboard can talk to it.
//   POST /content-sources/session  a signed-in PERSON (never an API key) gets a 4 minute signed token.
//   GET  /content-sources/jwks     the public key the companion service verifies with. Public, cacheable.
// Both answer exactly like an unknown route until CONTENT_SOURCES_TOKENS_ENABLED=true, so the feature is invisible
// while switched off. Deliberately not in the OpenAPI document: it describes only what an API key can reach.
// A configuration problem answers a fixed 503 and logs a fixed tag plus the error class, never the message or any key.

import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth, requireHumanAuth, type AuthedRequest } from "../auth.js";
import { publicRateLimit, tieredRateLimit } from "../rateLimit.js";
import { resolveTier } from "../../tier.js";
import { getPublicJwks, isEnabled, issueSessionToken } from "../../contentSources/sessionToken.js";

const NOT_AVAILABLE = "Not available right now.";

// Hands the request on as if this route did not exist, so the response is the router's own unknown-route answer.
const whenEnabled = (_req: Request, _res: Response, next: NextFunction) => (isEnabled() ? next() : next("route"));

function notAvailable(res: Response, err: unknown): void {
  console.error("content-sources token: not available", err instanceof Error ? err.name : typeof err);
  res.status(503).json({ error: NOT_AVAILABLE });
}

export function buildContentSourcesRouter(opts: { now?: () => Date } = {}): Router {
  const router = Router();
  const now = opts.now ?? (() => new Date());

  // Per signed-in person, in memory like the repo's other abuse limiters; created per router so each has its own counters.
  const perUser = rateLimit({
    windowMs: 60_000,
    max: 10,
    keyGenerator: (req: Request) => (req as AuthedRequest).userId ?? "unknown",
    standardHeaders: false,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
    },
    validate: false,
  });

  router.post("/content-sources/session", whenEnabled, requireAuth, requireHumanAuth, tieredRateLimit, perUser, async (req: AuthedRequest, res) => {
    try {
      const tier = await resolveTier(req.accountId as string);
      const { token, expiresAt } = issueSessionToken({ userId: req.userId as string, accountId: req.accountId as string, tier, now: now() });
      res.json({ token, expiresAt: expiresAt.toISOString() });
    } catch (err) {
      notAvailable(res, err);
    }
  });

  router.get("/content-sources/jwks", whenEnabled, publicRateLimit, (_req, res) => {
    try {
      const keys = getPublicJwks();
      res.set("Cache-Control", "public, max-age=300").json(keys);
    } catch (err) {
      notAvailable(res, err);
    }
  });

  return router;
}
