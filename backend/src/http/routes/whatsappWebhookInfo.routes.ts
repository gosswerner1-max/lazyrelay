// GET /whatsapp/webhook-info: what a customer needs to point THEIR OWN Meta app's webhook at LazyRelay, plus whether each
// of their WhatsApp connections can receive messages yet.
//
//   - Signed in (requireAuth), only while WHATSAPP_BYOK_ENABLED is on (404 otherwise, like the messages route), and only
//     on a plan that includes WhatsApp (checkWhatsappPlan: Free, Starter and Pro get the same fixed HTTP 400 message as
//     the other WhatsApp routes).
//   - webhookUrl: the public address of GET/POST /api/webhooks/whatsapp. Base from PUBLIC_API_BASE_URL (no trailing slash
//     needed), default the production API host that openapi.ts and mcpAuth.ts already publish.
//   - verifyToken: the shared HANDSHAKE string every customer types into their own Meta app's webhook settings. It is not
//     an API credential: it cannot send or read a message. Webhook deliveries are verified per connection with the
//     customer's own App Secret. Unset gives null and verifyTokenConfigured false.
//   - connections[].inboundReady is a boolean and nothing else: true only when the connection's Vault login holds a valid
//     App Secret. The Vault is read with the service-role client; the secret never leaves this function.
//   - Each lookup is scoped to the caller's account (explicit account_id filter on top of the row level security of req.db).
//   - Cache-Control: no-store.

import { Router } from "express";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { supabase } from "../../supabase.js";
import { checkWhatsappPlan } from "../../accountLimits.js";
import { WHATSAPP_BYOK_REQUIRED_PLAN_NAME } from "../../tier.js";
import { parseWhatsAppBundle } from "../../platforms/whatsapp/credentials.js";
import { dbError } from "./shared.js";

/** Documented default: the production API host (same host as the OpenAPI servers entry and the hosted MCP resource). */
export const DEFAULT_PUBLIC_API_BASE_URL = "https://lazyrelaylazyrelay-backend.onrender.com";
export const WHATSAPP_WEBHOOK_PATH = "/api/webhooks/whatsapp";

export function whatsappWebhookUrl(): string {
  const raw = (process.env.PUBLIC_API_BASE_URL ?? "").trim() || DEFAULT_PUBLIC_API_BASE_URL;
  return raw.replace(/\/+$/, "") + WHATSAPP_WEBHOOK_PATH;
}

interface ConnectionRow {
  id: string;
  display_name: string | null;
  access_token_vault_id: string | null;
}

/** True only when the stored login parses and holds a valid App Secret. Any failure is false. Never returns the value. */
async function hasAppSecret(vaultId: string | null): Promise<boolean> {
  if (!vaultId) return false;
  try {
    const { data, error } = await supabase.rpc("read_social_token", { p_vault_id: vaultId });
    if (error) return false;
    return Boolean(parseWhatsAppBundle(typeof data === "string" ? data : null)?.appSecret);
  } catch {
    return false;
  }
}

export function buildWhatsAppWebhookInfoRouter(): Router {
  const router = Router();

  router.get("/whatsapp/webhook-info", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    res.set("Cache-Control", "no-store");
    if (process.env.WHATSAPP_BYOK_ENABLED !== "true") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const planError = await checkWhatsappPlan(req.accountId!);
    if (planError) {
      res.status(400).json({ error: planError, requiresPlan: WHATSAPP_BYOK_REQUIRED_PLAN_NAME });
      return;
    }

    const { data, error } = await req
      .db!.from("social_accounts")
      .select("id, display_name, access_token_vault_id")
      .eq("account_id", req.accountId!)
      .eq("platform", "whatsapp")
      .is("disconnected_at", null);
    if (error) {
      dbError(res, error, "GET /whatsapp/webhook-info");
      return;
    }
    const rows = (data ?? []) as unknown as ConnectionRow[];
    const connections = await Promise.all(
      rows.map(async (r) => ({
        socialAccountId: r.id,
        displayName: r.display_name ?? "WhatsApp",
        inboundReady: await hasAppSecret(r.access_token_vault_id),
      })),
    );

    const token = (process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? "").trim();
    res.json({
      webhookUrl: whatsappWebhookUrl(),
      verifyToken: token || null,
      verifyTokenConfigured: Boolean(token),
      connections,
      triageEnabled: process.env.WHATSAPP_INBOUND_TRIAGE_ENABLED === "true",
    });
  });

  return router;
}
