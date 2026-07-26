import express from "express";
import cors from "cors";
import { buildRouter } from "./routes.js";
import { buildWebhookHandler } from "./webhook.js";
import type { MerchantOfRecordAdapter } from "../billing/types.js";
import type { PlatformAdapterRegistry } from "../platforms/connect.js";

export function buildApp(morAdapter: MerchantOfRecordAdapter, registry: PlatformAdapterRegistry) {
  const app = express();

  // Render sits in front of the app behind exactly one reverse proxy hop,
  // which sets X-Forwarded-For. Without this, express-rate-limit can't
  // tell real client IPs from the proxy's and throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
  app.set("trust proxy", 1);

  // Webhook route needs the raw body for signature verification — mounted
  // BEFORE express.json() so the JSON parser never touches it.
  app.post("/api/webhooks/mor", express.raw({ type: "application/json" }), buildWebhookHandler(morAdapter));

  app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:5173" }));
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
