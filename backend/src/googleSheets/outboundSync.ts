// LazyRelay -> Sheets sync. Called synchronously at the moment of an
// existing mutation (create/update/reschedule/approve/delete a scheduled
// post) -- same "no new poll loop" principle as googleCalendar/
// outboundSync.ts. Deliberately a no-op when the account has no active
// connection, so callers can call this unconditionally.

import { supabase } from "../supabase.js";
import { getGoogleAccessToken } from "./tokens.js";
import { postToSheetRow, sheetLinkFormula, SHEET_TAB_TITLE, type ScheduledPostForSheet } from "./sheetMapper.js";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
// Generous fixed range, cleared before every rewrite so a shrinking list
// never leaves stale rows behind from a previous, longer sync.
const MAX_TRACKED_ROWS = 2000;
// Only rows from this far in the past onward are shown -- keeps the sheet
// from growing forever with ancient posted history while staying a
// genuinely useful record of "what recently went out and what's coming."
const HISTORY_WINDOW_DAYS = 30;

interface GoogleSheetsConnectionRow {
  id: string;
  spreadsheet_id: string;
}

async function getActiveConnection(accountId: string): Promise<GoogleSheetsConnectionRow | null> {
  const { data, error } = await supabase
    .from("google_sheets_connections")
    .select("id, spreadsheet_id")
    .eq("account_id", accountId)
    .is("disconnected_at", null)
    .maybeSingle();
  if (error) {
    console.error("[googleSheets/outboundSync] failed to load connection:", error.message);
    return null;
  }
  return data;
}

interface SheetsErrorResponse {
  error?: { message?: string };
}

/** Rewrites the account's entire Content Calendar sheet from current
 *  scheduled_posts state. Deliberately a full rebuild rather than tracking
 *  individual row positions -- Sheets has no per-row id/PATCH-by-id
 *  primitive the way Calendar events do, so incrementally updating "the
 *  right row" would need a hidden id column plus a lookup scan before every
 *  write. A full rewrite is simpler, always correct, and cheap at the
 *  volumes a single account's calendar actually has. Never throws -- a
 *  failed sheet sync must never fail or block the action that triggered
 *  it, same principle as syncPostToCalendar. */
export async function syncAccountSheet(accountId: string): Promise<void> {
  const connection = await getActiveConnection(accountId);
  if (!connection) return;

  try {
    const sinceIso = new Date(Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: posts, error } = await supabase
      .from("scheduled_posts")
      .select("content, scheduled_for, status, social_accounts(platform, display_name)")
      .eq("account_id", accountId)
      .gte("scheduled_for", sinceIso) // also excludes drafts, whose scheduled_for is null
      .order("scheduled_for", { ascending: true })
      .limit(MAX_TRACKED_ROWS);
    if (error) {
      console.error("[googleSheets/outboundSync] failed to load posts:", error.message);
      return;
    }

    const accessToken = await getGoogleAccessToken(connection.id);
    const rangePrefix = encodeURIComponent(SHEET_TAB_TITLE);

    // Clear first -- if the list shrank since the last sync (a post was
    // deleted), a straight overwrite would leave stale rows below the new,
    // shorter data.
    await fetch(`${SHEETS_API_BASE}/${connection.spreadsheet_id}/values/${rangePrefix}!A2:G${MAX_TRACKED_ROWS + 1}:clear`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!posts || posts.length === 0) {
      await supabase.from("google_sheets_connections").update({ last_synced_at: new Date().toISOString() }).eq("id", connection.id);
      return;
    }

    const rows: ScheduledPostForSheet[] = posts.map((post) => {
      // Supabase's PostgREST client types a to-one embed as an array even
      // though the FK guarantees exactly one row here (same quirk
      // googleCalendar/outboundSync.ts already works around for this exact
      // relation).
      const socialAccount = Array.isArray(post.social_accounts) ? post.social_accounts[0] : post.social_accounts;
      const account = socialAccount as { platform?: string; display_name?: string | null } | undefined;
      const platformLabel = account?.platform ? account.platform[0].toUpperCase() + account.platform.slice(1) : null;
      return {
        content: post.content,
        scheduled_for: post.scheduled_for as string,
        status: post.status,
        platform_label: platformLabel,
        account_label: account?.display_name ?? null,
      };
    });

    // Data columns first, RAW -- never let customer-authored content
    // starting with +/-/@ get misparsed as a formula (a real bug hit in the
    // unrelated Lazy Download Wedding Planner spreadsheet work).
    const dataRange = `${rangePrefix}!A2:F${rows.length + 1}`;
    const dataRes = await fetch(`${SHEETS_API_BASE}/${connection.spreadsheet_id}/values/${dataRange}?valueInputOption=RAW`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows.map((row) => postToSheetRow(row)) }),
    });
    if (!dataRes.ok) {
      const json = (await dataRes.json().catch(() => ({}))) as SheetsErrorResponse;
      console.error(`[googleSheets/outboundSync] data write failed for account ${accountId}:`, json.error?.message ?? dataRes.status);
      return;
    }

    // Link column separately, USER_ENTERED -- the one column LazyRelay
    // always fully controls (never customer text), so a HYPERLINK formula
    // is safe here even though RAW is required everywhere else.
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
    const linkRange = `${rangePrefix}!G2:G${rows.length + 1}`;
    await fetch(`${SHEETS_API_BASE}/${connection.spreadsheet_id}/values/${linkRange}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows.map(() => [sheetLinkFormula(frontendUrl)]) }),
    });

    await supabase.from("google_sheets_connections").update({ last_synced_at: new Date().toISOString() }).eq("id", connection.id);
  } catch (err) {
    console.error(`[googleSheets/outboundSync] sync error for account ${accountId}:`, err instanceof Error ? err.message : err);
  }
}
