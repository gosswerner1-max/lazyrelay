// POST /referral/claim: a Google sign in carries no signup metadata, so the browser hands the stored partner code over here once, after
// the sign in. Signed in people only (never an API key). The account always comes from the login. The accounts table has no client
// update policy (migration 0069), so this goes through the server. A bad or unknown code is a quiet { claimed: false }.
//   Rules: only an approved partner's code, only when the account has no code yet, and only within the 30 day attribution window
//   (an old account that clicks a partner link later cannot be claimed).

import { Router, type Response } from "express";
import { requireAuth, requireHumanAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { supabase } from "../../supabase.js";
import { resolveApprovedPartnerCode } from "../../billing/partnerCode.js";

const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReferralClaimDeps {
  resolvePartnerCode?: (code: unknown) => Promise<string | null>;
}

async function claimOnAccount(accountId: string, code: string): Promise<boolean> {
  const now = new Date();
  const since = new Date(now.getTime() - ATTRIBUTION_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("accounts")
    .update({ referred_by_code: code, referred_at: now.toISOString() })
    .eq("id", accountId)
    .is("referred_by_code", null)
    .gte("created_at", since)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`referral claim update failed: ${error.message}`);
  return Boolean(data);
}

export function buildReferralClaimRouter(deps: ReferralClaimDeps = {}): Router {
  const router = Router();
  const resolve = deps.resolvePartnerCode ?? resolveApprovedPartnerCode;

  router.post("/claim", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res: Response) => {
    try {
      const code = await resolve((req.body as { code?: unknown } | undefined)?.code);
      if (!code) {
        res.json({ claimed: false });
        return;
      }
      res.json({ claimed: await claimOnAccount(req.accountId as string, code) });
    } catch (err) {
      console.error("referral claim failed:", err);
      res.json({ claimed: false });
    }
  });

  return router;
}
