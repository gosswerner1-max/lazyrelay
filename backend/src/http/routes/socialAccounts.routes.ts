// socialAccounts routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.
// Follow-up the same day: hand-written request-body type/length checks
// replaced with zod schemas (see http/validation.ts) — same messages, same
// accept/reject rules, same order.

import { Router } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { startConnect, completeConnect, getPendingSelection, finalizeConnectSelection, type PlatformAdapterRegistry } from "../../platforms/connect.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit, publicRateLimit } from "../rateLimit.js";
import { checkAccountLimit } from "../../accountLimits.js";
import { getAccessToken } from "../../scheduler.js";
import { getFrontendUrl, dbError } from "./shared.js";
import { validateBody, optionalNullableString } from "../validation.js";

// Every platform LazyRelay supports, in the shape the frontend's platform
// picker grid needs. "x" had a comingSoon gate until 2026-07-31 — its
// adapter is now built, credentials are live on Render, and it's confirmed
// in the registry, so it's a real, connectable platform now, not just "not
// configured." Reddit was dropped from the roadmap entirely on 2026-07-30
// in favor of Snapchat (see
// product/reference-social-automation-saas-venture-research and
// lazyrelay/project-snapchat-replaces-reddit-2026-07-30 memory), then
// Snapchat itself was dropped 2026-09-03 (its Public Profile API allowlisting
// turned out to be gated on an Account Manager assignment Snap wouldn't
// commit to a timeline on) and its adapter (platforms/snapchat.ts) removed
// entirely rather than left dark — see
// lazyrelay/project-snapchat-replaces-reddit-2026-07-30 memory for the
// decision. "x" is comingSoon: true — the adapter is code-complete and
// registered, but X's API is pay-per-use (Basic tier $200/mo just for write
// access), and the user decided 2026-08-04 to hold off funding it until
// there's real customer demand, rather than pay for an untested, unused
// integration. Google Business Profile was dropped entirely 2026-09-17
// (Werner's call): LazyRelay itself can't get its own Business Profile
// verified (Google's only offered method, a video walkthrough, requires
// branded documentation and a branded vehicle LazyRelay doesn't have and
// never will), and the API access application was abandoned as a result
// rather than resubmitted — the adapter (platforms/googleBusiness.ts) was
// removed rather than left dark, same treatment Snapchat got.
const ALL_PLATFORMS = [
  "tiktok", "pinterest", "youtube", "mastodon", "bluesky", "telegram",
  "linkedin", "threads", "facebook", "instagram", "discord", "tumblr", "x",
] as const;
const COMING_SOON_PLATFORMS = new Set<string>(["x"]);

export function buildSocialAccountsRouter(registry: PlatformAdapterRegistry): Router {
  const router = Router();

  // Drives the frontend's platform-picker grid — every platform LazyRelay
  // supports, whether it's actually configured (in the registry) right
  // now, and whether it's a "coming soon" tile that should never be
  // clickable regardless of configuration.
  router.get("/platforms", requireAuth, tieredRateLimit, (_req: AuthedRequest, res) => {
    res.json(
      ALL_PLATFORMS.map((platform) => ({
        platform,
        configured: registry.has(platform),
        comingSoon: COMING_SOON_PLATFORMS.has(platform),
      })),
    );
  });

  // Starts the "connect your social account" flow — returns the URL the
  // frontend should redirect the user to. Real account identity comes from
  // the verified JWT; the callback below never has to trust anything the
  // browser sends except the opaque, one-time state token.
  router.get("/social-accounts/connect", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { platform } = req.query;
    if (typeof platform !== "string" || !ALL_PLATFORMS.includes(platform as (typeof ALL_PLATFORMS)[number])) {
      res.status(400).json({ error: `platform must be one of: ${ALL_PLATFORMS.join(", ")}` });
      return;
    }
    if (COMING_SOON_PLATFORMS.has(platform)) {
      res.status(400).json({ error: `${platform} is coming soon and isn't available to connect yet.` });
      return;
    }
    try {
      // Real per-tier cap, not just marketing copy — see accountLimits.ts
      // for why even the top tier is capped rather than truly unlimited.
      const limitError = await checkAccountLimit(req.accountId!);
      if (limitError) {
        res.status(403).json({ error: limitError });
        return;
      }
      const { url, stateId } = await startConnect(req.accountId!, platform, registry);
      // Binds this specific browser to this specific state token — without
      // it, the state row alone only proves which ACCOUNT started the
      // flow, not which browser, so an attacker could mint this URL for
      // themselves and hand it to a victim: the victim clicks "Allow" on
      // the real platform, and completeConnect() would otherwise happily
      // link the victim's real social account into the attacker's
      // LazyRelay account. The callback below requires this same cookie
      // to be present and match. 15 minutes, matching oauth_states'
      // own expiry (see migration 0004).
      res.cookie("lr_oauth_state", stateId, {
        httpOnly: true,
        secure: true,
        // "none", not "lax": the frontend and backend are different origins
        // (see app.ts's allowedOrigins), so this cookie is set via a
        // cross-origin fetch() and — for Bluesky/Telegram/Discord, which
        // never leave the page — read back via another cross-origin
        // fetch() too, not a top-level navigation. Lax would only survive
        // the real-OAuth-platform redirect path and silently break those
        // three. Requires Secure, already set above.
        sameSite: "none",
        maxAge: 15 * 60_000,
      });
      res.json({ authorizeUrl: url });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The OAuth callback — NOT behind requireAuth, since the platform
  // redirects the browser here directly with no way to attach our JWT.
  // Identity/authorization instead comes entirely from the state token,
  // which was minted server-side for a specific account and can only be
  // used once (see platforms/connect.ts).
  //
  // This is the platform's own redirect_uri, so the browser lands here —
  // on the API's domain, not the frontend's — no matter what. The one
  // thing that WAS broken (not something this refactor introduced): once
  // the exchange finished, this used to just dead-end on a raw JSON blob
  // instead of ever sending the customer back to their dashboard. It now
  // redirects to the frontend either way, success or failure, with a query
  // param the dashboard reads once and clears (see Dashboard.tsx).
  //
  // Bluesky/Telegram/Discord have no real OAuth redirect_uri — ConnectForm
  // hits this exact route via fetch() instead, with `?format=json`. A
  // redirect response is wrong for that caller: fetch() follows it
  // automatically, the hop lands on the frontend's origin, and that origin
  // (plain static hosting) sends no CORS headers — so the browser throws
  // "Failed to fetch" even though completeConnect() above already
  // succeeded and the account is genuinely connected (confirmed live
  // 2026-08-06: reproduced on Bluesky/Telegram/Discord, DB always correct,
  // only the fetch() call itself failed). `format=json` opts into a real
  // JSON response instead, without changing behavior for the real OAuth
  // platforms that still navigate the browser here directly.
  const frontendUrl = getFrontendUrl();
  router.get("/social-accounts/callback", publicRateLimit, async (req, res) => {
    const { code, state } = req.query;
    const wantsJson = req.query.format === "json";
    if (typeof code !== "string" || typeof state !== "string") {
      const message = "Missing code or state";
      if (wantsJson) {
        res.status(400).json({ error: message });
        return;
      }
      res.redirect(`${frontendUrl}/?connectError=${encodeURIComponent(message)}`);
      return;
    }
    // Requires the same browser that started the connect flow (and got
    // handed the lr_oauth_state cookie in the /social-accounts/connect
    // response) to be the one completing it — the state row alone proves
    // which account started the flow, not which browser, which is what a
    // forged/shared authorize link could otherwise exploit. Cleared either
    // way, since this cookie is one-time-use just like the state row.
    const cookieState = req.cookies?.lr_oauth_state;
    res.clearCookie("lr_oauth_state", { httpOnly: true, secure: true, sameSite: "none" });
    if (cookieState !== state) {
      const message = "This connect link wasn't opened in the same browser it was started in — please try connecting again.";
      if (wantsJson) {
        res.status(403).json({ error: message });
        return;
      }
      res.redirect(`${frontendUrl}/?connectError=${encodeURIComponent(message)}`);
      return;
    }
    try {
      const result = await completeConnect(state, code, registry);
      if (result.status === "needs_selection") {
        if (wantsJson) {
          res.json({ connected: false, needsSelection: true, selectionToken: result.selectionToken });
          return;
        }
        res.redirect(`${frontendUrl}/?selectAccount=${encodeURIComponent(result.selectionToken)}`);
        return;
      }
      if (wantsJson) {
        res.json({ connected: true, socialAccountId: result.socialAccountId });
        return;
      }
      res.redirect(`${frontendUrl}/?connected=1`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (wantsJson) {
        res.status(400).json({ error: message });
        return;
      }
      res.redirect(`${frontendUrl}/?connectError=${encodeURIComponent(message)}`);
    }
  });

  // Real Page/account picker, for adapters where one OAuth login can map to
  // several destinations (Facebook: multiple Pages; Instagram: whichever
  // Page has a Business Account linked) — see connect.ts. requireAuth here
  // is real defense-in-depth on top of getPendingSelection's own
  // account-ownership check, not the only thing enforcing it.
  router.get("/social-accounts/pending-selection/:token", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { token } = req.params;
    if (typeof token !== "string") {
      res.status(400).json({ error: "token is required" });
      return;
    }
    try {
      const pending = await getPendingSelection(token, req.accountId);
      res.json(pending);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  const FINALIZE_SELECTION_ERROR = "token and selectedIds (a non-empty array of strings) are required";
  const finalizeSelectionBodySchema = z.object({
    token: z.string({ error: FINALIZE_SELECTION_ERROR }),
    selectedIds: z.array(z.string({ error: FINALIZE_SELECTION_ERROR }), { error: FINALIZE_SELECTION_ERROR }),
  });
  router.post("/social-accounts/finalize-selection", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(finalizeSelectionBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { token, selectedIds } = body.data;
    try {
      const socialAccountIds = await finalizeConnectSelection(token, selectedIds, req.accountId, registry);
      res.json({ connected: true, socialAccountIds });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Pilot route for the RLS rework (2026-09-04) -- the first one switched
  // to req.db, the per-request client requireAuth now builds (see auth.ts)
  // so migration 0081/0082's policies become real enforcement, not just
  // correct-looking database rows. req.db is the service-role client
  // unchanged for API-key/admin-key callers, which legitimately act as
  // the account itself with no user JWT to build a per-request client
  // from -- same account_id filter, same result either way.
  router.get("/social-accounts", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await req.db!
      .from("social_accounts")
      .select("id, platform, platform_account_id, display_name, connected_at, disconnected_at, brand_label, brand_id")
      .eq("account_id", req.accountId)
      .is("disconnected_at", null);
    if (error) {
      dbError(res, error, "GET /social-accounts");
      return;
    }
    res.json(data);
  });

  // Assign (or clear) a connected account's brand. brandId must reference a
  // brand owned by this caller, or be null to unbrand. Also writes the
  // brand_label mirror (see the transition note above).
  const assignBrandBodySchema = z.object({ brandId: optionalNullableString("brandId must be a string or null") });
  router.patch("/social-accounts/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(assignBrandBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { brandId } = body.data;
    let brandName: string | null = null;
    if (brandId) {
      const { data: brand, error: brandError } = await req.db!
        .from("brands")
        .select("id, name")
        .eq("id", brandId)
        .eq("account_id", req.accountId)
        .maybeSingle();
      if (brandError) {
        dbError(res, brandError, "PATCH /social-accounts/:id brand lookup");
        return;
      }
      if (!brand) {
        res.status(404).json({ error: "Brand not found or not owned by this caller" });
        return;
      }
      brandName = brand.name;
    }
    const { data, error } = await req.db!
      .from("social_accounts")
      .update({ brand_id: brandId ?? null, brand_label: brandName })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select("id, platform, platform_account_id, display_name, connected_at, disconnected_at, brand_label, brand_id")
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /social-accounts/:id");
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    res.json(data);
  });

  // Disconnecting was previously UI-only — there was no backend route at
  // all, so a customer who wanted to unlink an account (wrong account
  // connected, revoking access, switching accounts) had no way to actually
  // do it. Soft-delete via `disconnected_at`, the same reversible pattern
  // this table already uses everywhere else (GET /social-accounts already
  // filters on it) — not a hard delete, consistent with how the rest of
  // this schema treats "removed." The stored token itself is left in the
  // vault rather than actively revoked: none of the three manual platforms
  // (Bluesky app password, Telegram bot admin, Discord webhook) expose a
  // programmatic revoke, and the real OAuth platforms' tokens simply
  // become unreachable dead weight once this row stops being selectable —
  // same as every other soft-deleted row in this system.
  router.delete("/social-accounts/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error, count } = await req.db!
      .from("social_accounts")
      .update({ disconnected_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .is("disconnected_at", null)
      .select()
      .maybeSingle();
    if (error) {
      dbError(res, error, "DELETE /social-accounts/:id");
      return;
    }
    if (!count || !data) {
      res.status(404).json({ error: "Not found, not owned by this caller, or already disconnected" });
      return;
    }
    res.status(204).end();
  });

  // Real board list for a connected account — drives the Pinterest board
  // picker in the compose form, replacing the adapter's own provisional
  // "whichever board comes back first" default with an actual customer
  // choice. Returns 200 with an empty array for any platform whose adapter
  // doesn't declare listBoards (i.e. every platform except Pinterest today)
  // rather than a 404/400 — "nothing to pick" is a legitimate response, not
  // an error, so the frontend doesn't need a platform allowlist of its own.
  router.get("/social-accounts/:id/boards", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: account, error } = await req.db!
      .from("social_accounts")
      .select("account_id, platform, access_token_vault_id")
      .eq("id", req.params.id)
      .single();
    if (error || !account || account.account_id !== req.accountId) {
      res.status(403).json({ error: "Social account not found or not owned by this caller" });
      return;
    }

    const adapter = registry.get(account.platform);
    if (!adapter?.listBoards) {
      res.json([]);
      return;
    }

    // read_social_token's EXECUTE grant is service_role only (see
    // 0003_fix_function_grants.sql) -- calling it via req.db would just
    // fail with a permissions error, so this stays on supabase.
    const { data: accessToken, error: tokenError } = await supabase.rpc("read_social_token", {
      p_vault_id: account.access_token_vault_id,
    });
    if (tokenError || !accessToken) {
      res.status(500).json({ error: "Could not load this account's access token" });
      return;
    }

    const boards = await adapter.listBoards(accessToken as string);
    res.json(boards);
  });

  // TikTok Content Sharing Guidelines, "Required UX Implementation" point 1:
  // the compose form must show the creator's nickname, stop a post when TikTok
  // says the creator can't post more right now, and check the video's length
  // against max_video_post_duration_sec. This returns those live values for
  // one connected account. Uses getAccessToken (not a raw token read like the
  // boards route above) because TikTok access tokens expire within ~24h.
  router.get("/social-accounts/:id/tiktok-creator-info", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data: account, error } = await req.db!
      .from("social_accounts")
      .select("account_id, platform")
      .eq("id", req.params.id)
      .single();
    if (error || !account || account.account_id !== req.accountId) {
      res.status(403).json({ error: "Social account not found or not owned by this caller" });
      return;
    }

    const adapter = registry.get(account.platform);
    if (!adapter?.getCreatorInfo) {
      res.status(404).json({ error: "Creator info is only available for TikTok accounts" });
      return;
    }

    try {
      const accessToken = await getAccessToken(req.params.id as string, adapter);
      res.json(await adapter.getCreatorInfo(accessToken));
    } catch (err) {
      console.warn(`tiktok-creator-info ${req.params.id}: ${err instanceof Error ? err.message : String(err)}`);
      res.status(502).json({ error: "Couldn't check this TikTok account right now" });
    }
  });

  return router;
}
