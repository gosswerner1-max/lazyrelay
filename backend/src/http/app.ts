import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { buildRouter } from "./routes.js";
import { buildWebhookHandler } from "./webhook.js";
import { mountMcp } from "./mcpRoutes.js";
import type { MerchantOfRecordAdapter } from "../billing/types.js";
import type { PlatformAdapterRegistry } from "../platforms/connect.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

export function buildApp(
  morAdapter: MerchantOfRecordAdapter,
  registry: PlatformAdapterRegistry,
  /** Supabase's OAuth authorization-server metadata. When absent (the
   *  OAuth server is switched off on the project) the hosted MCP endpoint
   *  is simply not mounted — see fetchSupabaseOAuthMetadata. */
  mcpOAuthMetadata?: OAuthMetadata | null,
) {
  const app = express();

  // Found in a security review: this leaked "runs Express" to every
  // response for free, telling an attacker which framework-specific
  // vulnerabilities to try first.
  app.disable("x-powered-by");

  // Render sits in front of the app behind exactly one reverse proxy hop,
  // which sets X-Forwarded-For. Without this, express-rate-limit can't
  // tell real client IPs from the proxy's and throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
  app.set("trust proxy", 1);

  // Webhook route needs the raw body for signature verification — mounted
  // BEFORE express.json() so the JSON parser never touches it.
  app.post("/api/webhooks/mor", express.raw({ type: "application/json" }), buildWebhookHandler(morAdapter));

  // Hosted MCP is mounted BEFORE the frontend CORS policy below on purpose.
  // That policy allows only the LazyRelay web origins, which is right for
  // the dashboard API and wrong here — an MCP client is an AI agent, not a
  // browser on our own domain, and would be CORS-rejected by it. MCP brings
  // its own origin policy (see mcpRoutes.ts).
  if (mcpOAuthMetadata) mountMcp(app, mcpOAuthMetadata);

  // The site is reachable at both the bare domain and the www subdomain
  // (DNS/hosting serves both rather than redirecting one to the other), so
  // a single FRONTEND_URL origin silently CORS-blocks whichever variant
  // isn't listed — confirmed live via a customer hitting www.lazyrelay.com
  // and getting "Failed to fetch" on every API call. Accept both.
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
  const allowedOrigins = new Set([frontendUrl]);
  try {
    const url = new URL(frontendUrl);
    const bareHost = url.hostname.replace(/^www\./, "");
    allowedOrigins.add(`${url.protocol}//${bareHost}`);
    allowedOrigins.add(`${url.protocol}//www.${bareHost}`);
  } catch {
    // frontendUrl wasn't a valid absolute URL (e.g. still the localhost
    // default) — the single entry already added is enough for that case.
  }
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Not allowed by CORS"));
      },
      // Needed so the browser will store and re-send the short-lived
      // lr_oauth_state cookie (see routes.ts's /social-accounts/connect
      // and /social-accounts/callback) across the cross-origin fetch calls
      // the frontend makes here — without this, Set-Cookie on the
      // connect-initiate response is silently dropped by the browser.
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", buildRouter(morAdapter, registry));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Catches middleware errors (e.g. multer's file-too-large rejection on
  // /media/upload) as clean JSON instead of falling through to Express's
  // default HTML error page.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: err.message });
  });

  return app;
}
