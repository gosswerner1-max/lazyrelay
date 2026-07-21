import type { Request, Response, NextFunction } from "express";
import { supabase } from "../supabase.js";

export interface AuthedRequest extends Request {
  accountId?: string;
}

/** Verifies the caller's Supabase JWT and attaches the account id to the
 *  request. Every route that touches customer data must use this — there
 *  is no "trust the request body" path for identifying who's calling,
 *  since that's exactly the kind of gap that turns into a real security
 *  incident (per the OAuth-token-storage research this whole schema is
 *  already built around). */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const token = authHeader.slice("Bearer ".length);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  req.accountId = data.user.id;
  next();
}
