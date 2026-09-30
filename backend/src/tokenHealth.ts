import { supabase } from "./supabase.js";
import { notifyOps } from "./notify.js";
import { sendReconnectNeededEmail } from "./email.js";
import { isInternalTestAccount } from "./internalTestAccounts.js";
import { dispatchWebhookEvent } from "./webhook.js";

// Shared by the scheduler (a refresh that fails while posting) and the daily
// token job. Kept out of scheduler.ts so neither imports the other.

/** True only when the platform itself says the customer's grant is dead
 *  (expired or revoked refresh token / grant). Deliberately narrow.
 *  `invalid_client` is NOT here: that means OUR app credentials are wrong
 *  (the 2026-09-29 TikTok secret incident), which the customer cannot fix by
 *  reconnecting, and flagging every customer for it would be a false alarm. */
export function isPermanentAuthError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid_client/i.test(message)) return false;
  return /invalid_grant|refresh[ _-]?token.{0,40}(expired|invalid|revoked|not valid)|(token|grant).{0,40}(has been|was|is) (expired|revoked)|session has been invalidated/i.test(
    message,
  );
}

export interface ReconnectSubject {
  id: string;
  account_id: string;
  platform: string;
  display_name: string | null;
  needs_reconnect_at?: string | null;
  reconnect_notified_at?: string | null;
}

const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  threads: "Threads",
  facebook: "Facebook",
  instagram: "Instagram",
  pinterest: "Pinterest",
  youtube: "YouTube",
  tumblr: "Tumblr",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  discord: "Discord",
  telegram: "Telegram",
  x: "X",
};
export const platformLabel = (p: string): string => PLATFORM_LABEL[p] ?? p;

/** Flags the account as needing a reconnect and, once per problem, tells the
 *  customer. `expired` false means "expires soon, reconnect before then":
 *  the customer is emailed but the account is NOT flagged yet, because it
 *  still works. Idempotent: safe to call every run. */
export async function flagReconnect(
  row: ReconnectSubject,
  reason: string,
  opts: { expired: boolean; expiresAt?: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  const firstFlag = opts.expired && !row.needs_reconnect_at;
  if (opts.expired) {
    await supabase
      .from("social_accounts")
      .update({ needs_reconnect_at: row.needs_reconnect_at ?? now, needs_reconnect_reason: reason })
      .eq("id", row.id);
  }
  if (firstFlag) {
    // Once per problem: tell the customer's webhook endpoints too.
    await dispatchWebhookEvent({
      accountId: row.account_id,
      event: "channel.needs_reconnect",
      socialAccountId: row.id,
      data: { socialAccountId: row.id, platform: row.platform, displayName: row.display_name, reason },
    });
  }
  if (row.reconnect_notified_at) return;

  const { data: account } = await supabase.from("accounts").select("email").eq("id", row.account_id).maybeSingle();
  const email = account?.email ?? null;
  const label = platformLabel(row.platform);
  const who = row.display_name ?? label;

  if (email && !isInternalTestAccount(email)) {
    sendReconnectNeededEmail(email, label, who, opts.expired, opts.expiresAt ?? null);
  } else if (firstFlag || !opts.expired) {
    // Our own accounts (or none on file): no customer email, but never let it
    // pass silently.
    await notifyOps(`${label} connection "${who}" ${opts.expired ? "has expired and needs reconnecting" : "expires soon"} (${reason}). No customer email sent (internal or no address).`);
  }
  await supabase.from("social_accounts").update({ reconnect_notified_at: now }).eq("id", row.id);
}

/** A successful refresh or reconnect clears the flag and the notified marker
 *  so a future problem is reported afresh. */
export async function clearReconnect(socialAccountId: string): Promise<void> {
  await supabase
    .from("social_accounts")
    .update({ needs_reconnect_at: null, needs_reconnect_reason: null, reconnect_notified_at: null })
    .eq("id", socialAccountId);
}
