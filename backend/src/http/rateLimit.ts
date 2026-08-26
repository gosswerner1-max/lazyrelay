import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import type { AuthedRequest } from "./auth.js";
import { resolveTier as resolveTierUncached, type Tier } from "../tier.js";
import { recordSecurityEvent } from "./securityAlerts.js";

function onRateLimited(req: Request, res: Response) {
  recordSecurityEvent("rate_limited", `${req.method} ${req.path} from ${req.ip ?? "unknown"}`);
  res.status(429).json({ error: "Too many requests — please slow down and try again shortly." });
}

// Requests/minute per tier. This limits request VOLUME against our own
// infra (and, once real platform adapters exist, protects LazyRelay's own
// app-level API quota with Meta/TikTok/Pinterest from one over-eager
// account) — it has nothing to do with AI-agent token cost, which the
// customer's own agent already pays for under the bring-your-own-agent
// model. Paid tiers get more headroom since "unlimited posts" is the
// actual product promise there; free tier is already capped on post count
// separately, this is just the request-rate backstop underneath it.
const TIER_LIMITS: Record<Tier, number> = {
  free: 60,
  pro: 300, // "Starter"
  business: 450, // "Pro"
  enterprise: 600, // "Business"
  agency: 600, // mirrors enterprise — not part of the 2026-08-17 Agency pricing decision
  agency_plus: 600, // mirrors enterprise, same reasoning
};

// Cached per account for a short window so every request doesn't cost a
// subscriptions lookup — tier changes (upgrade/cancel) take effect within
// this TTL, which is fine for a rate limit (not a security boundary).
const TIER_CACHE_TTL_MS = 60_000;
const tierCache = new Map<string, { tier: Tier; expiresAt: number }>();

async function resolveTier(accountId: string): Promise<Tier> {
  const cached = tierCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;

  const tier = await resolveTierUncached(accountId);
  tierCache.set(accountId, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
  return tier;
}

/** Per-account request-rate limit, gated by subscription tier. Must be
 *  mounted AFTER requireAuth on any route that uses it — it reads
 *  req.accountId, which requireAuth is what sets. */
export const tieredRateLimit = rateLimit({
  windowMs: 60_000,
  max: async (req: Request) => {
    const accountId = (req as AuthedRequest).accountId;
    if (!accountId) return 30; // shouldn't normally be reached post-requireAuth; a safe floor if it is
    return TIER_LIMITS[await resolveTier(accountId)];
  },
  keyGenerator: (req: Request) => (req as AuthedRequest).accountId ?? req.ip ?? "unknown",
  standardHeaders: true,
  legacyHeaders: false,
  handler: onRateLimited,
});

/** Request-rate limit for the hosted MCP endpoint. Same tier ladder and
 *  cache as tieredRateLimit, but it reads the account id from the verified
 *  OAuth token (req.auth.extra.accountId, set by requireBearerAuth via
 *  mcpAuth.ts) rather than req.accountId, which only requireAuth sets and
 *  the MCP path never calls. Must be mounted AFTER requireBearerAuth —
 *  before it, every request would fall to the shared IP key, which for an
 *  agent host is one key for many customers. */
export const mcpRateLimit = rateLimit({
  windowMs: 60_000,
  max: async (req: Request) => {
    const accountId = req.auth?.extra?.accountId;
    if (typeof accountId !== "string" || !accountId) return 30;
    return TIER_LIMITS[await resolveTier(accountId)];
  },
  keyGenerator: (req: Request) => {
    const accountId = req.auth?.extra?.accountId;
    return typeof accountId === "string" && accountId ? accountId : (req.ip ?? "unknown");
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: onRateLimited,
});

/** Coarse IP-based limiter for the one route that runs before/without
 *  requireAuth (the OAuth callback — the platform redirects the browser
 *  here directly, so there's no JWT to key on). Not tier-aware; it's a
 *  backstop against callback-endpoint abuse, not a usage control — the
 *  callback's real protection is its one-time-use state token. */
export const publicRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: onRateLimited,
});
