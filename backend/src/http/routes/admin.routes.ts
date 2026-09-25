// admin routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.

import { Router } from "express";
import { supabase } from "../../supabase.js";
import { requireAuth, requireHumanAuth, requireAdmin, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { dbError } from "./shared.js";

export function buildAdminRouter(): Router {
  const router = Router();

  // Admin-only: list every account on the platform. Not scoped to req.accountId
  // at all — the whole point of an admin key is seeing across every tenant,
  // not acting as one. Logged via requireAuth's admin path like every other
  // admin-key request.
  router.get("/admin/accounts", requireAuth, requireAdmin, tieredRateLimit, async (_req: AuthedRequest, res) => {
    const { data, error } = await supabase
      .from("accounts")
      .select("id, email, business_name, created_at, cancelled_at")
      .order("created_at", { ascending: false });
    if (error) {
      dbError(res, error, "GET /admin/accounts");
      return;
    }
    res.json(data);
  });

  // requireHumanAuth, not requireAdmin — this is the one place a real
  // Supabase login (never an API key, never the admin key itself) opens a
  // short window for the NEXT admin-key request to go through. See
  // migration 0037_admin_key_guard.sql and auth.ts's authorizeAdminRequest().
  // Real bug found in a security review, 2026-08-19: this route was
  // reachable by ANY signed-up customer, not just Werner — requireHumanAuth
  // only excludes API-key/admin-key auth, it says nothing about WHICH human.
  // That defeated the entire point of migration 0037's admin-key guard: any
  // customer (a free $0 signup is enough) could open the 10-minute approval
  // window that lets a leaked lzr_admin_ key bypass its own auto-revoke.
  // OPERATOR_ACCOUNT_IDS is a comma-separated allowlist of Werner's own
  // known account ids (set in .env/Render, never customer-editable) — the
  // simplest fix that doesn't require inventing a new schema concept for
  // something only one person needs today.
  const operatorAccountIds = new Set(
    (process.env.OPERATOR_ACCOUNT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  );
  router.post("/admin/announce", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    if (!req.accountId || !operatorAccountIds.has(req.accountId)) {
      res.status(403).json({ error: "This endpoint is restricted." });
      return;
    }
    const taskLabel = typeof req.body?.taskLabel === "string" ? req.body.taskLabel.slice(0, 500) : null;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Stays on supabase, not req.db: this route is requireAuth (not
    // requireAdmin), so req.db would be a real per-user client here -- but
    // admin_key_intents (0037_admin_key_guard.sql) has RLS enabled with no
    // policies ever written for it, an internal admin-system table meant
    // for the service-role client only. req.db would fail outright.
    const { error } = await supabase.from("admin_key_intents").insert({
      announced_by: req.accountId,
      task_label: taskLabel,
      expires_at: expiresAt,
    });
    if (error) {
      dbError(res, error, "POST /admin/announce");
      return;
    }
    res.json({ expiresAt, windowMinutes: 10 });
  });

  return router;
}
