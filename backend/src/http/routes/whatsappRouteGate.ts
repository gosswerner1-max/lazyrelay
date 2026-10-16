// What the WhatsApp broadcast and chat routes share: the gate, the human-only rule, and how a refusal code becomes an HTTP status.
//
// Gate, in this order, on every route but the capabilities answer: WHATSAPP_BYOK_ENABLED, WHATSAPP_BROADCASTS_ENABLED and
// WHATSAPP_SEND_ENABLED exactly "true" (else 404, the feature does not exist), the platform visible for the account (else 404), a
// signed-in HUMAN (an API key is refused: there is no API key, MCP, Zapier, bulk or duplicate path to send), then a paid plan (400).
// Account ids are never taken from the request: they come from the signed-in session.

import type { NextFunction, Response } from "express";
import { z } from "zod";
import { requireAuth, requireHumanAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { checkWhatsappPlan } from "../../accountLimits.js";
import { WHATSAPP_BYOK_REQUIRED_PLAN_NAME } from "../../tier.js";
import { supabase } from "../../supabase.js";
import { sendEnabled } from "../../whatsappBroadcast/flags.js";
import { canSeePlatform } from "./socialAccounts.routes.js";

export const UUID = z.string().uuid();

export function sendFlagGate(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!sendEnabled() || !canSeePlatform("whatsapp", req.accountId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

export async function sendPlanGate(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const planError = await checkWhatsappPlan(req.accountId!);
  if (planError) {
    res.status(400).json({ error: planError, requiresPlan: WHATSAPP_BYOK_REQUIRED_PLAN_NAME });
    return;
  }
  next();
}

/** Every broadcast and chat route: signed in, flags, a HUMAN (never an API key), a paid plan. */
export const humanRoute = [requireAuth, tieredRateLimit, sendFlagGate, requireHumanAuth, sendPlanGate];

/** The user id inside the already verified sign-in token, for the record of who did it. Null when not readable. */
export function userIdFromToken(token: string | undefined): string | null {
  try {
    const sub = (JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown }).sub;
    return typeof sub === "string" && UUID.safeParse(sub).success ? sub : null;
  } catch {
    return null;
  }
}

export async function ownsConnection(accountId: string, socialAccountId: string): Promise<boolean> {
  const { data, error } = await supabase.from("social_accounts").select("id").eq("id", socialAccountId).eq("account_id", accountId).eq("platform", "whatsapp").maybeSingle();
  if (error) throw new Error(`connection lookup failed: ${error.message}`);
  return !!data;
}

export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue.path.join(".") || "request"}: ${issue.message}`;
}

const STATUS: Record<string, number> = {
  not_found: 404,
  template_not_found: 404,
  connection_not_found: 404,
  storage_not_ready: 503,
  no_own_credentials: 409,
  connection_unavailable: 409,
  connection_paused: 409,
  opted_out: 409,
  recipient_opted_out: 409,
  window_closed: 409,
  window_closed_template_required: 409,
  no_opt_in: 409,
  us_marketing_blocked: 409,
  name_taken: 409,
  not_cancellable: 409,
  try_again: 502,
  unconfirmed: 502,
  send_failed: 502,
};

/** The HTTP status for a refusal code (anything not listed is a 400: the request itself was not acceptable). */
export function statusForRefusal(code: string): number {
  return STATUS[code] ?? 400;
}
