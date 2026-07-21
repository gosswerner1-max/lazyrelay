import express from "express";
import cors from "cors";
import { buildRouter } from "./routes.js";
import { buildWebhookHandler } from "./webhook.js";
import type { MerchantOfRecordAdapter } from "../billing/types.js";
import type { PlatformAdapter } from "../platforms/types.js";

export function buildApp(morAdapter: MerchantOfRecordAdapter, platformAdapter: PlatformAdapter) {
  const app = express();

  // Webhook route needs the raw body for signature verification — mounted
  // BEFORE express.json() so the JSON parser never touches it.
  app.post("/api/webhooks/mor", express.raw({ type: "application/json" }), buildWebhookHandler(morAdapter));

  app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:5173" }));
  app.use(express.json());
  app.use("/api", buildRouter(morAdapter, platformAdapter));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  return app;
}
