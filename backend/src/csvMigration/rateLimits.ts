// Per-user hourly limits for the CSV migration helper, stricter than the normal tiered limit: a preview parses up to 2 MB, a
// confirm writes up to 200 rows. Counted per signed-in user and per step, in memory (a restart resets them, which is the same
// accepted trade-off as the other abuse limiters in this API).

import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import type { AuthedRequest } from "../http/auth.js";
import { CONFIRM_RATE_PER_HOUR, PREVIEW_RATE_PER_HOUR } from "./limits.js";

const HOUR_MS = 60 * 60 * 1000;

function limiter(max: number) {
  return rateLimit({
    windowMs: HOUR_MS,
    max,
    keyGenerator: (req: Request) => (req as AuthedRequest).userId ?? (req as AuthedRequest).accountId ?? "unknown",
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({ error: "You have used all of your imports for this hour. Please try again later.", code: "rate_limited" });
    },
  });
}

export const csvPreviewRateLimit = limiter(PREVIEW_RATE_PER_HOUR);
export const csvConfirmRateLimit = limiter(CONFIRM_RATE_PER_HOUR);
