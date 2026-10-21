// Numbers and wording behind the Connections workspace (pure, no network). Platform logic is shared with the Posting workspace (postingChannels).

import type { ScheduledPost, SocialAccount } from "./api";
import { accountMatchesBrand } from "../pages/dashboard/dashboardHelpers";
import { COMPOSER_CHANNELS, channelStates, type ChannelState } from "./postingChannels";

export interface ConnectionSummary {
  connectedPlatforms: number;
  totalPlatforms: number;
  accounts: number;
  needReconnect: number;
  /** Accounts that have at least one queued post sitting paused. */
  pausedAccounts: number;
}

export function connectionSummary(accounts: SocialAccount[], posts: ScheduledPost[], brandFilter: string): ConnectionSummary {
  const mine = accounts.filter((a) => accountMatchesBrand(a, brandFilter));
  const pausedIds = new Set<string>();
  for (const p of posts) {
    if (p.status === "pending" && p.paused_at && p.social_account_id && mine.some((a) => a.id === p.social_account_id)) pausedIds.add(p.social_account_id);
  }
  return {
    connectedPlatforms: channelStates(accounts, brandFilter).filter((s) => s.connected).length,
    totalPlatforms: COMPOSER_CHANNELS.length,
    accounts: mine.length,
    needReconnect: mine.filter((a) => a.needs_reconnect_at).length,
    pausedAccounts: pausedIds.size,
  };
}

/** The small line under a platform name on its tile. */
export function tileText(s: ChannelState): string {
  if (s.connected) return s.accounts.length === 1 ? "1 account" : `${s.accounts.length} accounts`;
  return s.needsReconnect ? "Needs reconnecting. Click to Connect API" : "Click to Connect API";
}

export type IntegrationId = "gcal" | "gsheet" | "whatsapp";
export interface IntegrationState {
  id: IntegrationId;
  label: string;
  state: "checking" | "connected" | "not-connected" | "needs-reconnect";
  lastSyncedAt?: string | null;
  detail?: string;
}
type GoogleStatus = { last_synced_at?: string | null } | null | undefined;

function google(id: IntegrationId, label: string, status: GoogleStatus): IntegrationState {
  if (status === undefined) return { id, label, state: "checking" };
  if (status === null) return { id, label, state: "not-connected" };
  return { id, label, state: "connected", lastSyncedAt: status.last_synced_at ?? null };
}

/** Google status uses the dashboard's sentinel: undefined = not checked yet, null = not connected, object = connected. */
export function integrationStates(input: { gcal: GoogleStatus; gsheet: GoogleStatus; accounts: SocialAccount[] }): IntegrationState[] {
  const wa = input.accounts.filter((a) => a.platform === "whatsapp");
  const usable = wa.filter((a) => !a.needs_reconnect_at);
  const whatsapp: IntegrationState = usable.length > 0
    ? { id: "whatsapp", label: "WhatsApp", state: "connected", detail: usable.length === 1 ? "1 number" : `${usable.length} numbers` }
    : { id: "whatsapp", label: "WhatsApp", state: wa.length > 0 ? "needs-reconnect" : "not-connected" };
  return [google("gcal", "Google Calendar", input.gcal), google("gsheet", "Google Sheets", input.gsheet), whatsapp];
}
