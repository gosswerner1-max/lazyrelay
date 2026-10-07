// Wiping stored platform logins (decided by Werner 2026-10-07: the Data Deletion page promises that disconnecting
// revokes LazyRelay's access token, so LazyRelay's copy is destroyed, not just hidden).
//
// A login lives in Vault (vault.secrets), pointed at by social_accounts.access_token_vault_id and refresh_token_vault_id
// (and the same pair on the two Google connection tables). The access column is NOT NULL and a foreign key, so the secret
// cannot be deleted while the row exists: it is OVERWRITTEN with a harmless marker instead, the same way connect.ts scrubs a
// held login. After a wipe, reading the secret gives the marker, never a token.
//
// Wiping never blocks the customer: callers log a failure and carry on. A row only gets tokens_wiped_at once every secret
// behind it was overwritten, so sweepDisconnectedTokens() retries anything that failed, and also catches every connection that
// was disconnected before this existed.

import type { SupabaseClient } from "@supabase/supabase-js";

type Db = Pick<SupabaseClient, "from" | "rpc">;

export const WIPED_TOKEN_MARKER = "revoked";

/** Every table that holds a login in Vault, with the same three columns. */
export const TOKEN_TABLES = ["social_accounts", "google_calendar_connections", "google_sheets_connections"] as const;
export type TokenTable = (typeof TOKEN_TABLES)[number];

const SWEEP_BATCH = 100;

/** Overwrites each Vault secret with the marker. Returns how many were overwritten and how many failed. */
export async function wipeVaultSecrets(db: Db, vaultIds: Array<string | null | undefined>): Promise<{ wiped: number; failed: number }> {
  const ids = [...new Set(vaultIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  let wiped = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const { error } = await db.rpc("update_social_token", { p_vault_id: id, p_new_token: WIPED_TOKEN_MARKER });
      if (error) {
        failed += 1;
        console.error(`[tokenWipe] could not overwrite a stored login (vault id ${id}):`, error.message);
      } else {
        wiped += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`[tokenWipe] could not overwrite a stored login (vault id ${id}):`, err instanceof Error ? err.message : err);
    }
  }
  return { wiped, failed };
}

interface TokenRow {
  id: string;
  access_token_vault_id: string | null;
  refresh_token_vault_id: string | null;
}

async function wipeRows(db: Db, table: TokenTable, rows: TokenRow[]): Promise<{ wiped: number; failed: number }> {
  let wiped = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await wipeVaultSecrets(db, [row.access_token_vault_id, row.refresh_token_vault_id]);
    if (result.failed === 0) {
      const { error } = await db.from(table).update({ tokens_wiped_at: new Date().toISOString() }).eq("id", row.id);
      if (error) console.error(`[tokenWipe] wiped ${table} ${row.id} but could not record it:`, error.message);
      wiped += 1;
    } else {
      failed += 1;
    }
  }
  return { wiped, failed };
}

/** Wipes the logins of one connection. Used right after a disconnect. Returns true when every secret was overwritten. */
export async function wipeConnectionTokens(db: Db, table: TokenTable, column: "id" | "account_id", value: string): Promise<boolean> {
  const { data, error } = await db.from(table).select("id, access_token_vault_id, refresh_token_vault_id").eq(column, value);
  if (error) {
    console.error(`[tokenWipe] could not read ${table} to wipe its logins:`, error.message);
    return false;
  }
  const result = await wipeRows(db, table, (data ?? []) as TokenRow[]);
  return result.failed === 0;
}

/** Finds disconnected connections that still hold a login and wipes them. Run from the 6 hourly job. */
export async function sweepDisconnectedTokens(db: Db): Promise<{ wiped: number; failed: number }> {
  let wiped = 0;
  let failed = 0;
  for (const table of TOKEN_TABLES) {
    const { data, error } = await db
      .from(table)
      .select("id, access_token_vault_id, refresh_token_vault_id")
      .not("disconnected_at", "is", null)
      .is("tokens_wiped_at", null)
      .limit(SWEEP_BATCH);
    if (error) {
      console.error(`[tokenWipe] sweep could not read ${table}:`, error.message);
      failed += 1;
      continue;
    }
    const result = await wipeRows(db, table, (data ?? []) as TokenRow[]);
    wiped += result.wiped;
    failed += result.failed;
  }
  return { wiped, failed };
}
