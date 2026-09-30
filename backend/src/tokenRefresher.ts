import { supabase } from "./supabase.js";
import type { PlatformAdapterRegistry } from "./platforms/connect.js";
import { refreshAndStoreToken, TOKEN_ACCOUNT_COLUMNS, type TokenAccountRow } from "./scheduler.js";
import { flagReconnect, isPermanentAuthError } from "./tokenHealth.js";

// Keeps connections alive before they die, and tells the customer when only
// they can fix it. Runs every few hours (index.ts).
//
//  - Threads: tokens last 60 days and Meta only allows a refresh while the
//    token is still valid, so it is renewed in the last 10 days. Once it has
//    really expired it can never be renewed and the customer must reconnect.
//  - LinkedIn and any platform whose tokens expire but cannot be refreshed:
//    the customer is emailed 14 days ahead, and the account is flagged if it
//    lapses.
//  - Platforms with a stored refresh token (TikTok, Pinterest, YouTube,
//    Tumblr, Bluesky) are deliberately left to the on-demand refresh in
//    getAccessToken. Those grants rotate their refresh token on use, so a
//    second refresher running alongside a scheduled post could race it and
//    invalidate the login. A permanently rejected refresh is still flagged
//    there.
//  - Facebook and Instagram Page tokens do not expire (Meta docs), so they are
//    not touched here.

const DAY = 86_400_000;
export const REFRESH_WINDOW_MS = 10 * DAY;
export const WARN_WINDOW_MS = 14 * DAY;
const SOON_MS = 3 * DAY;

export interface TokenCycleResult {
  refreshed: number;
  flagged: number;
  warned: number;
  failed: number;
}

export async function runTokenRefreshCycle(registry: PlatformAdapterRegistry, now: number = Date.now()): Promise<TokenCycleResult> {
  const result: TokenCycleResult = { refreshed: 0, flagged: 0, warned: 0, failed: 0 };
  const { data, error } = await supabase
    .from("social_accounts")
    .select(TOKEN_ACCOUNT_COLUMNS)
    .is("disconnected_at", null)
    .not("token_expires_at", "is", null)
    .lt("token_expires_at", new Date(now + WARN_WINDOW_MS).toISOString())
    .limit(500);
  if (error) throw error;

  for (const row of (data ?? []) as TokenAccountRow[]) {
    const adapter = registry.get(row.platform);
    if (!adapter || !row.token_expires_at) continue;
    const expiresMs = new Date(row.token_expires_at).getTime();
    const msLeft = expiresMs - now;

    try {
      if (adapter.refreshUsesAccessToken) {
        if (msLeft <= 0) {
          await flagReconnect(row, `The ${row.platform} connection expired on ${row.token_expires_at.slice(0, 10)}.`, { expired: true, expiresAt: row.token_expires_at });
          result.flagged += 1;
        } else if (msLeft <= REFRESH_WINDOW_MS) {
          try {
            await refreshAndStoreToken(row, adapter);
            result.refreshed += 1;
          } catch (err) {
            if (isPermanentAuthError(err)) {
              await flagReconnect(row, "The platform rejected the saved login.", { expired: true });
              result.flagged += 1;
            } else {
              // Transient (network, platform hiccup): try again next run, but
              // don't let the customer run out of time silently.
              result.failed += 1;
              console.warn(`[tokenRefresher] refresh failed for ${row.platform} ${row.id}:`, err instanceof Error ? err.message : err);
              if (msLeft <= SOON_MS) {
                await flagReconnect(row, "Automatic renewal kept failing and the connection is about to expire.", { expired: false, expiresAt: row.token_expires_at });
                result.warned += 1;
              }
            }
          }
        }
      } else if (!adapter.refresh) {
        if (msLeft <= 0) {
          await flagReconnect(row, `The ${row.platform} connection expired on ${row.token_expires_at.slice(0, 10)}.`, { expired: true, expiresAt: row.token_expires_at });
          result.flagged += 1;
        } else if (msLeft <= WARN_WINDOW_MS) {
          await flagReconnect(row, `The ${row.platform} connection expires on ${row.token_expires_at.slice(0, 10)} and can't be renewed automatically.`, { expired: false, expiresAt: row.token_expires_at });
          result.warned += 1;
        }
      }
    } catch (err) {
      result.failed += 1;
      console.error(`[tokenRefresher] ${row.platform} ${row.id} threw:`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}
