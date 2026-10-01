// The Whop connect steps (see platforms/whopConnect.ts for the ownership proof and why it exists). Mounted by
// socialAccounts.routes.ts. Every route needs a signed-in LazyRelay customer, refuses unless Whop is registered AND
// switched on for this account (the same dormancy gate as the platform picker), and never returns the app key: the
// only Whop-specific value that leaves the server is the public install link.

import type { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { checkAccountLimit } from "../../accountLimits.js";
import { validateBody } from "../validation.js";
import { startWhopChallenge, verifyWhopChallenge } from "../../platforms/whopConnect.js";
import type { PlatformAdapterRegistry } from "../../platforms/connect.js";
import { WhopAdapter } from "../../platforms/whop.js";

export function registerWhopRoutes(router: Router, registry: PlatformAdapterRegistry, canSee: (platform: string, accountId: string | undefined) => boolean): void {
  // Returns the adapter, or answers 400 and returns null. Same words as the generic connect route's dormancy refusal.
  const gate = (req: AuthedRequest, res: { status: (n: number) => { json: (b: unknown) => void } }): WhopAdapter | null => {
    const adapter = registry.get("whop");
    if (!(adapter instanceof WhopAdapter) || !canSee("whop", req.accountId)) {
      res.status(400).json({ error: "whop isn't available to connect yet." });
      return null;
    }
    return adapter;
  };

  // Step 1 of the dialog: where the owner installs the LazyRelay app. The app id is served from here, never hardcoded
  // in the frontend.
  router.get("/social-accounts/whop/config", requireAuth, tieredRateLimit, (req: AuthedRequest, res) => {
    const adapter = gate(req, res);
    if (!adapter) return;
    res.json({ installUrl: adapter.installUrl });
  });

  // Step 2: the community. Returns the one-time code to post in a forum, and the forums to post it in.
  const challengeSchema = z.object({ company: z.string({ error: "company is required" }).max(400, "company is too long") });
  router.post("/social-accounts/whop/challenge", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const adapter = gate(req, res);
    if (!adapter) return;
    const body = validateBody(challengeSchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    try {
      const limitError = await checkAccountLimit(req.accountId!);
      if (limitError) {
        res.status(403).json({ error: limitError });
        return;
      }
      res.json(await startWhopChallenge(adapter.api, req.accountId!, body.data.company));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Step 3: check the proof. On success the answer is a selection token for the usual forum picker.
  const verifySchema = z.object({ challengeId: z.string({ error: "challengeId is required" }).max(80, "challengeId is too long") });
  router.post("/social-accounts/whop/verify", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const adapter = gate(req, res);
    if (!adapter) return;
    const body = validateBody(verifySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    try {
      res.json(await verifyWhopChallenge(adapter.api, req.accountId!, body.data.challengeId));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
