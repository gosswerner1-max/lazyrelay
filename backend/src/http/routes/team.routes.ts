// team routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.
// Follow-up the same day: hand-written request-body type/length checks
// replaced with zod schemas (see http/validation.ts) — same messages, same
// accept/reject rules, same order.

import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { requireAuth, requireHumanAuth, requireOwner, requireJwtUser, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { checkSeatLimit } from "../../seatLimits.js";
import { sendTeamInviteEmail } from "../../email.js";
import { dbError } from "./shared.js";
import { validateBody, nonEmptyString } from "../validation.js";

// Team invites (2026-08-17) -- no separate expires_at column; invited_at
// already exists and resend (POST /team/:id/resend) resets it, so the same
// timestamp doubles as "clock start" for both display and this check.
const TEAM_INVITE_EXPIRY_MS = 72 * 60 * 60 * 1000;

export function buildTeamRouter(): Router {
  const router = Router();

  // Agency tier v1 (migration 0053, account_members). Deliberately not
  // tier-gated yet -- Werner hasn't set Agency-tier pricing/seat limits, so
  // gating this on a specific paid tier now would mean inventing a pricing
  // rule rather than following one. Any account can use it today; adding a
  // tier check here is the natural place once that pricing decision exists.
  router.get("/team", requireAuth, requireHumanAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await req.db!
      .from("account_members")
      .select("id, user_id, invited_email, role, invited_at, accepted_at")
      .eq("account_id", req.accountId)
      .order("invited_at", { ascending: true });
    if (error) {
      dbError(res, error, "GET /team");
      return;
    }
    res.json(data);
  });

  const teamInviteBodySchema = z.object({
    email: z
      .string({ error: "A valid email is required" })
      .refine((s) => /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(s.trim()), "A valid email is required"),
  });
  router.post("/team/invite", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const seatLimitError = await checkSeatLimit(req.accountId!);
    if (seatLimitError) {
      res.status(403).json({ error: seatLimitError });
      return;
    }

    const body = validateBody(teamInviteBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { email } = body.data;
    const normalizedEmail = email.trim().toLowerCase();

    const { data: account } = await req.db!.from("accounts").select("email, business_name").eq("id", req.accountId).maybeSingle();
    if (account?.email && account.email.toLowerCase() === normalizedEmail) {
      res.status(400).json({ error: "That's your own email address" });
      return;
    }

    const { data: existing } = await req.db!
      .from("account_members")
      .select("id, accepted_at")
      .eq("account_id", req.accountId)
      .ilike("invited_email", normalizedEmail)
      .maybeSingle();
    if (existing) {
      res.status(409).json({ error: existing.accepted_at ? "Already a team member" : "Already invited, waiting on acceptance" });
      return;
    }

    // Stays on supabase, not req.db: account_members has no INSERT policy
    // at all (0081_team_aware_rls_policies.sql's own comment: "invite/
    // accept/remove has seat-limit business logic... that belongs behind a
    // backend/RPC boundary, not raw RLS") -- req.db would fail outright.
    const { data: invite, error } = await supabase
      .from("account_members")
      .insert({ account_id: req.accountId, invited_email: normalizedEmail, role: "member" })
      .select("id, invite_token")
      .single();
    if (error || !invite) {
      dbError(res, error ?? { message: "insert returned no row" }, "POST /team/invite");
      return;
    }

    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
    const acceptUrl = `${frontendUrl}/team/accept?token=${invite.invite_token}`;
    sendTeamInviteEmail(normalizedEmail, account?.business_name || account?.email || "A LazyRelay account", acceptUrl);

    res.status(201).json({ id: invite.id, email: normalizedEmail, role: "member" });
  });

  router.delete("/team/:id", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: member } = await req.db!
      .from("account_members")
      .select("id, account_id, role")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!member || member.account_id !== req.accountId) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    if (member.role === "owner") {
      res.status(400).json({ error: "The account owner can't be removed" });
      return;
    }
    // Stays on supabase: account_members has no DELETE policy either, see
    // the comment on POST /team/invite above.
    const { error } = await supabase.from("account_members").delete().eq("id", req.params.id);
    if (error) {
      dbError(res, error, "DELETE /team/:id");
      return;
    }
    res.status(204).end();
  });

  // Resends a still-pending invite -- same email, same invite_token (no
  // reason to rotate it; an old copy of the email still working alongside
  // the new one is harmless, not a security concern), just a fresh
  // invited_at so it's good for another 72 hours (see TEAM_INVITE_EXPIRY_MS
  // in POST /team/accept-invite above). Real gap Werner asked to close,
  // 2026-08-17: without this, a missed/expired invite email meant deleting
  // the row and starting over instead of one click.
  router.post("/team/:id/resend", requireAuth, requireHumanAuth, requireOwner, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: member } = await req.db!
      .from("account_members")
      .select("id, account_id, invited_email, user_id, accepted_at, invite_token")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!member || member.account_id !== req.accountId) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    if (member.user_id || member.accepted_at) {
      res.status(400).json({ error: "This invite has already been accepted, there's nothing to resend" });
      return;
    }

    // Stays on supabase: account_members has no UPDATE policy either, see
    // the comment on POST /team/invite above.
    const { error } = await supabase
      .from("account_members")
      .update({ invited_at: new Date().toISOString() })
      .eq("id", member.id);
    if (error) {
      dbError(res, error, "POST /team/:id/resend");
      return;
    }

    const { data: account } = await req.db!.from("accounts").select("email, business_name").eq("id", req.accountId).maybeSingle();
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
    const acceptUrl = `${frontendUrl}/team/accept?token=${member.invite_token}`;
    sendTeamInviteEmail(member.invited_email!, account?.business_name || account?.email || "A LazyRelay account", acceptUrl);

    res.json({ resent: true });
  });

  // requireJwtUser, not requireAuth -- see its doc comment in auth.ts. This
  // is the one route where "who is calling" must be resolved independently
  // of account-membership lookup, since accepting is the act that creates
  // that membership in the first place.
  //
  // Every call below stays on supabase, not req.db: requireJwtUser is a
  // separate auth path from requireAuth and never sets req.db (see
  // AuthedRequest's own doc comment in auth.ts) -- it would be undefined
  // here regardless of table policy. account_members also has no
  // INSERT/UPDATE/DELETE policy anyway (see POST /team/invite above), so
  // even a req.db built here couldn't do this route's write.
  const acceptInviteBodySchema = z.object({ token: nonEmptyString("token is required") });
  router.post("/team/accept-invite", requireJwtUser, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(acceptInviteBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { token } = body.data;
    const { data: invite } = await supabase
      .from("account_members")
      .select("id, account_id, invited_email, user_id, accepted_at, invited_at")
      .eq("invite_token", token.trim())
      .maybeSingle();
    if (!invite || invite.user_id || invite.accepted_at) {
      res.status(404).json({ error: "This invite is invalid or has already been used" });
      return;
    }
    if (Date.now() - new Date(invite.invited_at).getTime() > TEAM_INVITE_EXPIRY_MS) {
      res.status(410).json({ error: "This invite has expired. Ask the account owner to resend it." });
      return;
    }
    if (!invite.invited_email || invite.invited_email.toLowerCase() !== req.jwtUser!.email.toLowerCase()) {
      res.status(403).json({ error: "This invite was sent to a different email address" });
      return;
    }

    // v1's stated limit: at most one OTHER account beyond your own -- see
    // resolveAccountForUser() in auth.ts. Checked here, at the one moment
    // the conflict can actually be created, rather than guessed at invite time.
    const { data: existingMembership } = await supabase
      .from("account_members")
      .select("id")
      .eq("user_id", req.jwtUser!.id)
      .eq("role", "member")
      .not("accepted_at", "is", null)
      .maybeSingle();
    if (existingMembership) {
      res.status(409).json({ error: "You're already a member of another team. Leave that one first." });
      return;
    }

    const { error } = await supabase
      .from("account_members")
      .update({ user_id: req.jwtUser!.id, accepted_at: new Date().toISOString() })
      .eq("id", invite.id)
      .is("user_id", null); // race guard, same pattern as admin_key_intents
    if (error) {
      dbError(res, error, "POST /team/accept-invite");
      return;
    }
    res.json({ accountId: invite.account_id });
  });

  return router;
}
