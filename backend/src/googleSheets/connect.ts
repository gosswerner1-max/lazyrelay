// Connect/disconnect flow for a customer's Google Sheets export. Same
// single-connection-per-account shape as googleCalendar/connect.ts, much
// simpler flow (no calendarList.insert-style second step) since a freshly
// created spreadsheet is immediately visible to the owner with no separate
// "subscribe" call needed.

import { supabase } from "../supabase.js";
import { getAuthorizeUrl as buildAuthorizeUrl, exchangeCode, fetchConnectedEmail, type GoogleTokens } from "./oauthClient.js";
import { HEADER_ROW, SHEET_TAB_TITLE } from "./sheetMapper.js";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SPREADSHEET_TITLE = "LazyRelay Content Calendar";

interface CreateSpreadsheetResponse {
  spreadsheetId?: string;
  sheets?: { properties?: { sheetId?: number } }[];
  error?: { message?: string };
}

/** Starts the connect flow: creates a short-lived CSRF state row and returns
 *  the URL to send the customer to. Mirrors startGoogleCalendarConnect. */
export async function startGoogleSheetsConnect(accountId: string): Promise<{ url: string; stateId: string }> {
  const { data, error } = await supabase
    .from("google_sheets_oauth_states")
    .insert({ account_id: accountId })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("Failed to start Google Sheets connect flow");

  const url = buildAuthorizeUrl(data.id);
  return { url, stateId: data.id };
}

async function createDedicatedSpreadsheet(accessToken: string): Promise<string> {
  const createRes = await fetch(SHEETS_API_BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { title: SPREADSHEET_TITLE },
      sheets: [{ properties: { title: SHEET_TAB_TITLE, gridProperties: { frozenRowCount: 1 } } }],
    }),
  });
  const createJson = (await createRes.json().catch(() => ({}))) as CreateSpreadsheetResponse;
  const spreadsheetId = createJson.spreadsheetId;
  const sheetId = createJson.sheets?.[0]?.properties?.sheetId;
  if (!createRes.ok || !spreadsheetId || sheetId === undefined) {
    throw new Error(createJson.error?.message ?? "Could not create the LazyRelay Content Calendar spreadsheet");
  }

  // Header row -- RAW, same reasoning as every data write in outboundSync.ts
  // (never let a literal string get parsed as a formula).
  const headerRange = `${encodeURIComponent(SHEET_TAB_TITLE)}!A1:G1`;
  await fetch(`${SHEETS_API_BASE}/${spreadsheetId}/values/${headerRange}?valueInputOption=RAW`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [HEADER_ROW] }),
  });

  // Bold the header row -- cosmetic only, best-effort (never blocks connect
  // if it fails; the sheet is fully functional without it).
  await fetch(`${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
      ],
    }),
  }).catch(() => {});

  return spreadsheetId;
}

/** Completes the connect flow: validates the CSRF state, exchanges the code,
 *  creates the dedicated spreadsheet, and stores everything. */
export async function completeGoogleSheetsConnect(
  state: string,
  code: string,
): Promise<{ connectionId: string; accountId: string; spreadsheetTitle: string }> {
  const { data: stateRow, error: stateError } = await supabase
    .from("google_sheets_oauth_states")
    .select("account_id, expires_at")
    .eq("id", state)
    .single();
  if (stateError || !stateRow) {
    throw new Error("Invalid or already-used connect link");
  }
  // One-time use either way, success or failure -- same as
  // google_calendar_oauth_states.
  await supabase.from("google_sheets_oauth_states").delete().eq("id", state);
  if (new Date(stateRow.expires_at) < new Date()) {
    throw new Error("Connect link expired — please try connecting again");
  }

  const tokens: GoogleTokens = await exchangeCode(code);
  const spreadsheetId = await createDedicatedSpreadsheet(tokens.accessToken);
  const connectedEmail = await fetchConnectedEmail(tokens.accessToken);

  const { data: accessVaultId, error: accessVaultError } = await supabase.rpc("store_social_token", {
    p_token: tokens.accessToken,
  });
  if (accessVaultError) throw accessVaultError;

  let refreshVaultId: string | null = null;
  if (tokens.refreshToken) {
    const { data, error } = await supabase.rpc("store_social_token", { p_token: tokens.refreshToken });
    if (error) throw error;
    refreshVaultId = data;
  }

  const { data: connection, error: insertError } = await supabase
    .from("google_sheets_connections")
    .upsert(
      {
        account_id: stateRow.account_id,
        access_token_vault_id: accessVaultId,
        refresh_token_vault_id: refreshVaultId,
        token_expires_at: tokens.expiresAt,
        spreadsheet_id: spreadsheetId,
        connected_email: connectedEmail,
        disconnected_at: null,
      },
      { onConflict: "account_id" },
    )
    .select("id")
    .single();
  if (insertError || !connection) throw insertError ?? new Error("Failed to save the Google Sheets connection");

  return { connectionId: connection.id, accountId: stateRow.account_id, spreadsheetTitle: SPREADSHEET_TITLE };
}

/** Disconnects a customer's Google Sheets export. Deliberately does NOT
 *  delete the spreadsheet on Google's side -- same conservative-deletion
 *  principle as disconnectGoogleCalendar: disconnecting stops syncing, it
 *  doesn't destroy anything the customer can see in their own Drive. */
export async function disconnectGoogleSheets(accountId: string): Promise<void> {
  const { error } = await supabase
    .from("google_sheets_connections")
    .update({ disconnected_at: new Date().toISOString() })
    .eq("account_id", accountId)
    .is("disconnected_at", null);
  if (error) throw error;
}
