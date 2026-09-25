// googleIntegrations routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.

import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { supabase } from "../../supabase.js";
import { isGoogleCalendarConfigured } from "../../googleCalendar/oauthClient.js";
import { startGoogleCalendarConnect, completeGoogleCalendarConnect, disconnectGoogleCalendar } from "../../googleCalendar/connect.js";
import { syncConnectionInbound, type GoogleCalendarConnectionRow } from "../../googleCalendar/inboundSync.js";
import { isGoogleSheetsConfigured } from "../../googleSheets/oauthClient.js";
import { startGoogleSheetsConnect, completeGoogleSheetsConnect, disconnectGoogleSheets } from "../../googleSheets/connect.js";
import { syncAccountSheet } from "../../googleSheets/outboundSync.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit, publicRateLimit } from "../rateLimit.js";
import { dbError, getFrontendUrl } from "./shared.js";

export function buildGoogleIntegrationsRouter(): Router {
  const router = Router();

  // See socialAccounts.routes.ts's /social-accounts/callback comment for why
  // the OAuth callbacks redirect back to the frontend.
  const frontendUrl = getFrontendUrl();

  // Google Calendar two-way sync — a genuinely different shape from every
  // other connection above (not a platform to post TO, a two-way data
  // source), so it's deliberately its own small route group rather than
  // folded into /social-accounts/connect's platform-registry flow. See
  // googleCalendar/connect.ts's header comment for why.
  router.get("/google-calendar/status", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await req.db!
      .from("google_calendar_connections")
      .select("google_calendar_id, connected_email, connected_at, last_synced_at")
      .eq("account_id", req.accountId)
      .is("disconnected_at", null)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /google-calendar/status");
      return;
    }
    res.json({ connected: !!data, ...data });
  });

  router.get("/google-calendar/connect", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    if (!isGoogleCalendarConfigured()) {
      res.status(400).json({ error: "Google Calendar sync isn't available yet." });
      return;
    }
    try {
      const { url, stateId } = await startGoogleCalendarConnect(req.accountId!);
      // Same CSRF binding as /social-accounts/connect's lr_oauth_state
      // cookie — a distinct cookie name so the two connect flows can be in
      // flight at once without clobbering each other.
      res.cookie("lr_gcal_oauth_state", stateId, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 15 * 60_000,
      });
      res.json({ authorizeUrl: url });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/google-calendar/callback", publicRateLimit, async (req, res) => {
    const { code, state } = req.query;
    if (typeof code !== "string" || typeof state !== "string") {
      res.redirect(`${frontendUrl}/?gcalConnectError=${encodeURIComponent("Missing code or state")}`);
      return;
    }
    const cookieState = req.cookies?.lr_gcal_oauth_state;
    res.clearCookie("lr_gcal_oauth_state", { httpOnly: true, secure: true, sameSite: "none" });
    if (cookieState !== state) {
      res.redirect(
        `${frontendUrl}/?gcalConnectError=${encodeURIComponent("This connect link wasn't opened in the same browser it was started in — please try connecting again.")}`,
      );
      return;
    }
    try {
      await completeGoogleCalendarConnect(state, code);
      res.redirect(`${frontendUrl}/?gcalConnected=1`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.redirect(`${frontendUrl}/?gcalConnectError=${encodeURIComponent(message)}`);
    }
  });

  router.delete("/google-calendar", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    try {
      await disconnectGoogleCalendar(req.accountId!);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Google Sheets content-calendar export — same reasoning as the Calendar
  // group above for why this is its own small route group: not a platform
  // to post to, its own independent connection. See googleSheets/connect.ts.
  router.get("/google-sheets/status", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const { data, error } = await req.db!
      .from("google_sheets_connections")
      .select("spreadsheet_id, connected_email, connected_at, last_synced_at")
      .eq("account_id", req.accountId)
      .is("disconnected_at", null)
      .maybeSingle();
    if (error) {
      dbError(res, error, "GET /google-sheets/status");
      return;
    }
    res.json({ connected: !!data, ...data });
  });

  router.get("/google-sheets/connect", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    if (!isGoogleSheetsConfigured()) {
      res.status(400).json({ error: "Google Sheets export isn't available yet." });
      return;
    }
    try {
      const { url, stateId } = await startGoogleSheetsConnect(req.accountId!);
      // Distinct cookie name from lr_gcal_oauth_state so the two connect
      // flows can be in flight at once without clobbering each other.
      res.cookie("lr_gsheet_oauth_state", stateId, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 15 * 60_000,
      });
      res.json({ authorizeUrl: url });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/google-sheets/callback", publicRateLimit, async (req, res) => {
    const { code, state } = req.query;
    if (typeof code !== "string" || typeof state !== "string") {
      res.redirect(`${frontendUrl}/?gsheetConnectError=${encodeURIComponent("Missing code or state")}`);
      return;
    }
    const cookieState = req.cookies?.lr_gsheet_oauth_state;
    res.clearCookie("lr_gsheet_oauth_state", { httpOnly: true, secure: true, sameSite: "none" });
    if (cookieState !== state) {
      res.redirect(
        `${frontendUrl}/?gsheetConnectError=${encodeURIComponent("This connect link wasn't opened in the same browser it was started in — please try connecting again.")}`,
      );
      return;
    }
    try {
      const { accountId } = await completeGoogleSheetsConnect(state, code);
      // First sync happens right away so the customer sees real data the
      // moment they land back — not empty rows waiting on their next edit.
      void syncAccountSheet(accountId);
      res.redirect(`${frontendUrl}/?gsheetConnected=1`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.redirect(`${frontendUrl}/?gsheetConnectError=${encodeURIComponent(message)}`);
    }
  });

  router.delete("/google-sheets", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    try {
      await disconnectGoogleSheets(req.accountId!);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Google's push notification endpoint (Phase 3, pushNotifications.ts) --
  // NOT behind requireAuth, same reasoning as /google-calendar/callback:
  // Google calls this directly with no way to attach our JWT. Identity
  // instead comes from X-Goog-Channel-Token, a random secret we generated
  // and stored per-connection at subscribe time, which Google echoes back
  // on every call for that channel. The notification itself carries no
  // data -- just "something changed" -- so a valid call just re-runs the
  // exact same syncConnectionInbound() the hourly poller already calls.
  router.post("/google-calendar/webhook", publicRateLimit, async (req, res) => {
    const channelId = req.header("X-Goog-Channel-ID");
    const receivedToken = req.header("X-Goog-Channel-Token");
    const resourceState = req.header("X-Goog-Resource-State");
    if (!channelId || !receivedToken) {
      res.status(404).end();
      return;
    }

    const { data: connection } = await supabase
      .from("google_calendar_connections")
      .select("id, account_id, google_calendar_id, sync_token, target_social_account_ids, watch_channel_token")
      .eq("watch_channel_id", channelId)
      .is("disconnected_at", null)
      .maybeSingle();

    const storedToken = connection?.watch_channel_token;
    // timingSafeEqual throws on mismatched buffer lengths rather than
    // returning false -- guard explicitly instead of catching, since an
    // unregistered/wrong channel id is an expected case, not an error.
    const tokenMatches =
      !!storedToken &&
      Buffer.byteLength(storedToken) === Buffer.byteLength(receivedToken) &&
      timingSafeEqual(Buffer.from(storedToken), Buffer.from(receivedToken));
    if (!connection || !tokenMatches) {
      res.status(404).end();
      return;
    }

    // Google's one-time handshake message when a channel starts -- nothing
    // to sync yet, just acknowledge it.
    if (resourceState === "sync") {
      res.status(200).end();
      return;
    }

    const row: GoogleCalendarConnectionRow = {
      id: connection.id,
      account_id: connection.account_id,
      google_calendar_id: connection.google_calendar_id,
      sync_token: connection.sync_token,
      target_social_account_ids: connection.target_social_account_ids,
    };
    await syncConnectionInbound(row);
    res.status(200).end();
  });

  return router;
}
