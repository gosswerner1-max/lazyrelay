// socialAccounts routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.
// Follow-up the same day: hand-written request-body type/length checks
// replaced with zod schemas (see http/validation.ts) — same messages, same
// accept/reject rules, same order.

import { getPlatformRules } from "../../platformRules.js";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { supabase } from "../../supabase.js";
import { startConnect, completeConnect, getPendingSelection, finalizeConnectSelection, cancelConnectSelection, type PlatformAdapterRegistry } from "../../platforms/connect.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit, publicRateLimit } from "../rateLimit.js";
import { checkAccountLimit } from "../../accountLimits.js";
import { getAccessToken } from "../../scheduler.js";
import { wipeConnectionTokens } from "../../tokenWipe.js";
import { getFrontendUrl, dbError } from "./shared.js";
import { validateBody, optionalNullableString } from "../validation.js";
import { normalizeMastodonInstance } from "../../platforms/mastodon.js";
import { ConnectLimitError } from "../../platforms/mastodonInstanceLimit.js";
import { registerWhopRoutes } from "./whopConnect.routes.js";
import { registerXByokRoutes, X_BYOK_PLAN_MESSAGE } from "./xByok.routes.js";
import { resolveTier, canUseXByok, X_BYOK_REQUIRED_PLAN_NAME } from "../../tier.js";

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
  "wordpress", "devto", "hashnode", "lemmy", "slack", "nostr", "whop",
] as const;
// Nothing is "coming soon" any more: X is connectable with the customer's own developer keys (Pro and above), and is
// hidden entirely until X_BYOK_ENABLED registers it and X_BYOK_PLATFORM_PUBLIC (or a test account list) opens it.
const COMING_SOON_PLATFORMS = new Set<string>();
// New platforms stay out of the picker entirely until they are switched on for this deploy, so customers never
// see a tile for something that is not ready. While a platform is being proven on real accounts it is switched on
// only for the accounts named in ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS (comma separated); once proven,
// ARTICLE_PLATFORMS_PUBLIC=true opens it to everyone. Everything else keeps its dimmed "not set up" tile when
// its settings are missing.
//
// Slack has its own pair of switches (SLACK_PLATFORM_PUBLIC, SLACK_TEST_ACCOUNT_IDS) so it can be released, or tried
// on a test account, independently of the article platforms. It is also absent from the registry until its three
// Slack settings exist, so two separate things must both be true before any customer sees a Slack tile.
// Nostr likewise has its own pair (NOSTR_PLATFORM_PUBLIC, NOSTR_TEST_ACCOUNT_IDS) and is only in the registry once
// NOSTR_CONNECT_PAGE_URL is set.
// Whop likewise has its own pair (WHOP_PLATFORM_PUBLIC, WHOP_TEST_ACCOUNT_IDS) and is only in the registry once both
// WHOP_APP_API_KEY and WHOP_APP_ID are set. None of the other switches (Slack, Nostr, article platforms) opens it.
// X likewise has its own pair (X_BYOK_PLATFORM_PUBLIC, X_BYOK_TEST_ACCOUNT_IDS) and is only in the registry once X_BYOK_ENABLED=true.
const HIDDEN_UNTIL_CONFIGURED = new Set<string>(["wordpress", "devto", "hashnode", "lemmy", "slack", "nostr", "whop", "x"]);
const GATE_ENV: Record<string, { publicFlag: string; testers: string }> = {
  slack: { publicFlag: "SLACK_PLATFORM_PUBLIC", testers: "SLACK_TEST_ACCOUNT_IDS" },
  nostr: { publicFlag: "NOSTR_PLATFORM_PUBLIC", testers: "NOSTR_TEST_ACCOUNT_IDS" },
  whop: { publicFlag: "WHOP_PLATFORM_PUBLIC", testers: "WHOP_TEST_ACCOUNT_IDS" },
  x: { publicFlag: "X_BYOK_PLATFORM_PUBLIC", testers: "X_BYOK_TEST_ACCOUNT_IDS" },
};
const ARTICLE_GATE_ENV = { publicFlag: "ARTICLE_PLATFORMS_PUBLIC", testers: "ARTICLE_PLATFORMS_TEST_ACCOUNT_IDS" };
function canSeePlatform(platform: string, accountId: string | undefined): boolean {
  if (!HIDDEN_UNTIL_CONFIGURED.has(platform)) return true;
  const gate = GATE_ENV[platform] ?? ARTICLE_GATE_ENV;
  if (process.env[gate.publicFlag] === "true") return true;
  const testers = (process.env[gate.testers] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return !!accountId && testers.includes(accountId);
}

export function buildSocialAccountsRouter(registry: PlatformAdapterRegistry): Router {
  const router = Router();

  // Drives the frontend's platform-picker grid — every platform LazyRelay
  // supports, whether it's actually configured (in the registry) right
  // now, and whether it's a "coming soon" tile that should never be
  // clickable regardless of configuration.
  router.get("/platforms", requireAuth, tieredRateLimit, async (_req: AuthedRequest, res) => {
    const visible = ALL_PLATFORMS.filter((platform) => !HIDDEN_UNTIL_CONFIGURED.has(platform) || (registry.has(platform) && canSeePlatform(platform, _req.accountId)));
    // The X tile says whether THIS account's plan includes connecting with its own keys (the UI never decides).
    // Looked up only when the X tile is shown.
    let xAllowed = false;
    if (visible.includes("x")) {
      try {
        xAllowed = canUseXByok(await resolveTier(_req.accountId!));
      } catch {
        xAllowed = false;
      }
    }
    res.json(
      visible.map((platform) => ({
        platform,
        configured: registry.has(platform),
        comingSoon: COMING_SOON_PLATFORMS.has(platform),
        ...(platform === "x" ? { requiresPlan: X_BYOK_REQUIRED_PLAN_NAME, allowed: xAllowed } : {}),
      })),
    );
  });

  // What each platform accepts, so an AI agent (MCP get_platform_rules) or an API caller can check BEFORE
  // scheduling: text limit, media rules, required fields, features and options. Static data: platformRules.ts.
  router.get("/platforms/rules", requireAuth, tieredRateLimit, (req: AuthedRequest, res) => {
    const platform = typeof req.query.platform === "string" && req.query.platform.trim() ? req.query.platform.trim().toLowerCase() : undefined;
    const platforms = getPlatformRules(platform);
    if (platform && platforms.length === 0) {
      res.status(404).json({ error: `Unknown platform "${platform}". Known platforms: ${getPlatformRules().map((p) => p.platform).join(", ")}.` });
      return;
    }
    res.json({ platforms });
  });

  registerWhopRoutes(router, registry, canSeePlatform);
  registerXByokRoutes(router, registry, canSeePlatform);

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
    if (!canSeePlatform(platform, req.accountId)) {
      res.status(400).json({ error: `${platform} isn't available to connect yet.` });
      return;
    }
    // X has no sign-in redirect either: the customer pastes their own developer keys (routes/xByok.routes.ts). The plan
    // gate is enforced here too, so a free account gets the upgrade answer rather than a pointer to a form it cannot use.
    if (platform === "x") {
      let allowed = false;
      try {
        allowed = canUseXByok(await resolveTier(req.accountId!));
      } catch {
        allowed = false;
      }
      if (!allowed) {
        res.status(403).json({ error: X_BYOK_PLAN_MESSAGE, requiresPlan: X_BYOK_REQUIRED_PLAN_NAME });
        return;
      }
      res.status(400).json({ error: "X is connected with your own developer keys from Social Platforms, not through a sign-in redirect." });
      return;
    }
    // Whop has no sign-in redirect: it is connected from its own dialog (routes/whopConnect.routes.ts), where the
    // customer has to prove they own the community.
    if (platform === "whop") {
      res.status(400).json({ error: "Whop is connected from its own connect dialog in Social Platforms." });
      return;
    }
    // Mastodon only: the customer's own server. Blank or mastodon.social means the default
    // flow, unchanged. Anything else is validated here (https host name only) and travels
    // through the connect state to the code exchange.
    let instanceContext: string | undefined;
    if (platform === "mastodon" && typeof req.query.instance === "string" && req.query.instance.trim()) {
      const norm = normalizeMastodonInstance(req.query.instance);
      if (!norm.ok) {
        res.status(400).json({ error: norm.error });
        return;
      }
      if (norm.origin !== "https://mastodon.social") instanceContext = norm.origin;
    }
    try {
      // Real per-tier cap, not just marketing copy — see accountLimits.ts
      // for why even the top tier is capped rather than truly unlimited.
      const limitError = await checkAccountLimit(req.accountId!);
      if (limitError) {
        res.status(403).json({ error: limitError });
        return;
      }
      const { url, stateId } = await startConnect(req.accountId!, platform, registry, instanceContext);
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
      res.status(err instanceof ConnectLimitError ? 429 : 500).json({ error: err instanceof Error ? err.message : String(err) });
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
  //
  // The credential-paste platforms (Bluesky, Telegram, Discord, WordPress, dev.to, Hashnode, Lemmy, Nostr) used to
  // send the pasted secret as `?code=` on this GET, so an app password or a Lemmy password ended up in the
  // address and in every request log. They now POST the same two values in the body (always answered with
  // JSON). The GET stays for the real OAuth redirects, and for a connect page cached before this change.
  const handleCallback = async (req: Request, res: Response, code: unknown, state: unknown, wantsJson: boolean) => {
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
  };
  router.get("/social-accounts/callback", publicRateLimit, (req, res) => handleCallback(req, res, req.query.code, req.query.state, req.query.format === "json"));
  router.post("/social-accounts/callback", publicRateLimit, (req, res) => handleCallback(req, res, req.body?.code, req.body?.state, true));

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
      const pending = await getPendingSelection(token, req.accountId, registry);
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
    // Pinterest confirmation only: "this account is already warmed up".
    warmedUp: z.boolean().optional(),
  });
  router.post("/social-accounts/finalize-selection", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(finalizeSelectionBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const { token, selectedIds, warmedUp } = body.data;
    try {
      const socialAccountIds = await finalizeConnectSelection(token, selectedIds, req.accountId, registry, { warmedUp });
      res.json({ connected: true, socialAccountIds });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // The customer saw which account they were about to connect and chose not
  // to (or it was the wrong one). Deletes the in-flight connect and scrubs the
  // login LazyRelay was holding for the confirmation.
  const cancelSelectionBodySchema = z.object({ token: z.string({ error: "token is required" }) });
  router.post("/social-accounts/cancel-selection", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(cancelSelectionBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    try {
      await cancelConnectSelection(body.data.token, req.accountId);
      res.json({ cancelled: true });
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
    // The three X "own keys" markers (migration 0123) are only selected while X_BYOK_ENABLED is on, so this route cannot
    // break on a database that does not have the columns yet. They are non-secret by design (a status and a masked hint).
    const byokColumns = process.env.X_BYOK_ENABLED === "true";
    // Two literal column lists (the plain one first): a test reads this source to prove no token column is selected.
    const { data: rows, error } = !byokColumns
      ? await req.db!
          .from("social_accounts")
          .select("id, platform, platform_account_id, display_name, connected_at, disconnected_at, needs_reconnect_at, brand_label, brand_id")
          .eq("account_id", req.accountId)
          .is("disconnected_at", null)
      : await req.db!
          .from("social_accounts")
          .select("id, platform, platform_account_id, display_name, connected_at, disconnected_at, needs_reconnect_at, brand_label, brand_id, credential_mode, byok_status, byok_key_hint")
          .eq("account_id", req.accountId)
          .is("disconnected_at", null);
    if (error) {
      dbError(res, error, "GET /social-accounts");
      return;
    }
    if (!byokColumns) {
      res.json(rows);
      return;
    }
    res.json(
      (rows as unknown as Array<Record<string, unknown>>).map(({ credential_mode, byok_status, byok_key_hint, ...rest }) => ({
        ...rest,
        credentialMode: credential_mode ?? "platform",
        byokStatus: byok_status ?? null,
        byokKeyHint: byok_key_hint ?? null,
      })),
    );
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
      .select("id, platform, platform_account_id, display_name, connected_at, disconnected_at, needs_reconnect_at, brand_label, brand_id")
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
  // this schema treats "removed." The stored login IS destroyed (2026-10-07,
  // Werner: the Data Deletion page promises disconnecting revokes LazyRelay's
  // access token): its Vault secrets are overwritten right after the row is
  // marked disconnected (tokenWipe.ts), and a sweep retries anything that
  // failed, so a failure here never blocks the disconnect. This does not call
  // the platform to revoke its own copy; the customer can also remove
  // LazyRelay from that platform's connected-apps settings.
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
    await wipeConnectionTokens(supabase, "social_accounts", "id", req.params.id as string);
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
