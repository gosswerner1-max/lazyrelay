import { supabase } from "../supabase.js";
import { checkNewDistinctAccountLimit } from "../accountLimits.js";
import { subscribePageToMessaging } from "../http/metaWebhook.js";
import type { PlatformAdapter, OAuthExchangeResult, ConnectOption } from "./types.js";
import { checkMastodonInstanceLimit } from "./mastodonInstanceLimit.js";

export type PlatformAdapterRegistry = Map<string, PlatformAdapter>;

export type CompleteConnectResult =
  | { status: "connected"; socialAccountId: string }
  | { status: "needs_selection"; selectionToken: string; options: ConnectOption[] };

function resolveAdapter(registry: PlatformAdapterRegistry, platform: string): PlatformAdapter {
  const adapter = registry.get(platform);
  if (!adapter) throw new Error(`"${platform}" isn't available to connect right now.`);
  return adapter;
}

// Every OAuth connect now stops at a confirmation step before anything is
// saved (2026-09-30, Werner: a customer must be asked, not silently connected
// to whichever account is already signed in on the platform). For adapters
// with no Page/channel picker of their own, the freshly exchanged login is
// held server-side in Vault, wrapped in this marker so finalize can tell it
// apart from a Facebook/Instagram/YouTube picker's raw user token.
const CONFIRM_PAYLOAD_MARKER = "__lazyrelay_confirm__";

function parseConfirmPayload(held: string): OAuthExchangeResult | null {
  if (!held.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(held) as { [CONFIRM_PAYLOAD_MARKER]?: boolean; result?: OAuthExchangeResult };
    return parsed[CONFIRM_PAYLOAD_MARKER] && parsed.result ? parsed.result : null;
  } catch {
    return null;
  }
}

// Shared by the plain single-account path and both branches of the
// picker path (auto-finalized single option, and a real customer pick) —
// same upsert-on-reconnect behavior either way.
async function storeConnectedAccount(
  accountId: string,
  platform: string,
  result: OAuthExchangeResult,
): Promise<string> {
  // Reconnecting an account we already know (same account_id + platform +
  // platform_account_id) is exempt from the distinct-account limit below --
  // it isn't a new account, just a token refresh/re-auth, and blocking it
  // would break the "click Connect again" path checkAccountLimit already
  // lets through. Only a genuinely never-seen platform_account_id gets
  // checked against the rolling window. See accountLimits.ts for why this
  // exists (checkAccountLimit alone only caps accounts held open AT ONCE,
  // not distinct accounts cycled through over time).
  const { data: existingAccount } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("account_id", accountId)
    .eq("platform", platform)
    .eq("platform_account_id", result.platformAccountId)
    .maybeSingle();
  if (!existingAccount) {
    const limitError = await checkNewDistinctAccountLimit(accountId);
    if (limitError) throw new Error(limitError);
  }

  const { data: accessVaultId, error: accessVaultError } = await supabase.rpc("store_social_token", {
    p_token: result.accessToken,
  });
  if (accessVaultError) throw accessVaultError;

  let refreshVaultId: string | null = null;
  if (result.refreshToken) {
    const { data, error } = await supabase.rpc("store_social_token", { p_token: result.refreshToken });
    if (error) throw error;
    refreshVaultId = data;
  }

  // Upsert, not insert: reconnecting a platform you're already connected to
  // (same account_id + platform + platform_account_id, which is unique) is
  // the common case, not an edge case — a token refresh, a re-auth after
  // revoking scopes, or just clicking "Connect" again. A plain insert hits
  // that unique constraint and fails, but the OAuth redirect back to the
  // dashboard happens regardless, so the failure was invisible: the user
  // sees what looks like a successful reconnect while the old, possibly
  // expired token silently stays in place and every post keeps using it.
  const { data: socialAccount, error: insertError } = await supabase
    .from("social_accounts")
    .upsert(
      {
        account_id: accountId,
        platform,
        platform_account_id: result.platformAccountId,
        display_name: result.displayName,
        access_token_vault_id: accessVaultId,
        refresh_token_vault_id: refreshVaultId,
        token_expires_at: result.expiresAt,
        disconnected_at: null,
        // A fresh connection clears any earlier "needs reconnect" flag.
        needs_reconnect_at: null,
        needs_reconnect_reason: null,
        reconnect_notified_at: null,
      },
      { onConflict: "account_id,platform,platform_account_id" },
    )
    .select("id")
    .single();
  if (insertError || !socialAccount) throw insertError;

  // Facebook/Instagram only. Confirmed live 2026-09-15: without this,
  // Instagram's Messaging API refuses every call outright regardless of
  // OAuth permissions already granted — see metaWebhook.ts. Best-effort:
  // logs and moves on rather than failing an otherwise-successful connect.
  if (result.metaPageSubscription) {
    await subscribePageToMessaging(result.metaPageSubscription.pageId, result.metaPageSubscription.pageAccessToken);
  }

  return socialAccount.id;
}

/** Starts a connect flow: creates a one-time, 15-minute state token tied to
 *  this account + platform, returns the URL to redirect the user to. The
 *  adapter is resolved from the registry by `platform` — this is what lets
 *  several platforms be connectable at once instead of just one globally
 *  injected adapter.
 *
 *  Also returns the raw state id so the route handler can bind it to the
 *  initiating browser via a cookie (see routes.ts) — the state row alone
 *  proves which ACCOUNT started the flow, but not which BROWSER, which is
 *  what let one customer's authorize link be handed to a victim and linked
 *  into the attacker's account instead of the state row's real owner. */
export async function startConnect(
  accountId: string,
  platform: string,
  registry: PlatformAdapterRegistry,
  // Only Mastodon uses this today: the https origin of the instance the customer chose
  // (already validated by the route). It travels in oauth_states.context and is read back
  // in completeConnect. Absent means the platform's default, exactly as before.
  context?: string,
): Promise<{ url: string; stateId: string }> {
  const adapter = resolveAdapter(registry, platform);
  // A customer's own Mastodon server: capped per account per day before anything is sent to it.
  if (context && adapter.platform === "mastodon") await checkMastodonInstanceLimit(accountId, context);
  const { data, error } = await supabase
    .from("oauth_states")
    .insert({ account_id: accountId, platform: adapter.platform, ...(context ? { context } : {}) })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create oauth state");

  const url = context ? await adapter.getAuthorizeUrl(data.id, context) : await adapter.getAuthorizeUrl(data.id);
  return { url, stateId: data.id };
}

/** Handles the OAuth callback: validates the state token (exists, not
 *  expired), resolves the correct adapter from the registry using the
 *  platform the state row was created for, and exchanges the code for real
 *  tokens.
 *
 *  Most adapters finish here: the state row is consumed (deleted — one-time
 *  use no matter what happens next, success or failure) and the result is
 *  stored with the token encrypted via Vault.
 *
 *  Adapters that declare listConnectOptions (currently Facebook/Instagram,
 *  where one login can map to several Pages/IG accounts) take a different
 *  path: if there's more than one real option, the state row is NOT
 *  deleted — instead it's updated to hold the candidate list and the
 *  long-lived user token (vault-encrypted), and this returns
 *  "needs_selection" so the customer can pick before anything is finalized.
 *  Exactly one option still finalizes immediately, same UX as a plain
 *  connect. */
export async function completeConnect(
  state: string,
  code: string,
  registry: PlatformAdapterRegistry,
): Promise<CompleteConnectResult> {
  const { data: stateRow, error: stateError } = await supabase
    .from("oauth_states")
    .select("account_id, platform, expires_at, pkce_verifier, context")
    .eq("id", state)
    .single();

  // One read, with the chosen server in it: if it fails the flow stops here. It never falls through
  // to a default server, which would send a customer's code to the wrong place.
  if (stateError || !stateRow) {
    throw new Error("Invalid or already-used connect link");
  }
  if (new Date(stateRow.expires_at) < new Date()) {
    await supabase.from("oauth_states").delete().eq("id", state);
    throw new Error("Connect link expired — please try connecting again");
  }

  // The adapter is looked up BY the platform the state row was created
  // for, not compared against a pre-selected single adapter — this makes
  // the old "platform mismatch" failure mode structurally impossible now
  // that every connect flow shares one callback route across all platforms.
  const adapter = resolveAdapter(registry, stateRow.platform);

  // Mastodon only: the instance the customer chose. A blank or missing value is the default flow
  // (mastodon.social), which is exactly what a connect started without an instance stored.
  const context = stateRow.platform === "mastodon" && typeof stateRow.context === "string" && stateRow.context.trim() ? stateRow.context : undefined;

  if (adapter.listConnectOptions) {
    const { userToken, options } = await adapter.listConnectOptions(code, stateRow.pkce_verifier ?? undefined);

    if (options.length === 0) {
      await supabase.from("oauth_states").delete().eq("id", state);
      throw new Error("No eligible account found to connect");
    }

    // One option or several, the customer is always asked: with a single
    // option the dashboard shows a "Connect this account?" confirmation
    // instead of a picker, so a login is never attached silently.

    // Hold the token for the choice — hold the long-lived token against THIS state
    // row instead of deleting it, so the frontend's follow-up "finalize"
    // call has something to reference. Reuses oauth_states' existing
    // expiry as the picker's own timeout.
    const { data: tokenVaultId, error: vaultError } = await supabase.rpc("store_social_token", {
      p_token: userToken,
    });
    if (vaultError) throw vaultError;

    const { error: updateError } = await supabase
      .from("oauth_states")
      .update({ pending_options: options, pending_token_vault_id: tokenVaultId })
      .eq("id", state);
    if (updateError) throw updateError;

    return { status: "needs_selection", selectionToken: state, options };
  }

  if (adapter.skipConnectConfirmation) {
    // Credential-form platforms (Bluesky, Telegram, Discord): the customer
    // just typed the account they want, so there is nothing to confirm.
    // Delete immediately, before doing anything else — one-time use no
    // matter what happens next, success or failure.
    await supabase.from("oauth_states").delete().eq("id", state);
    const result = await adapter.exchangeCode(code, stateRow.pkce_verifier ?? undefined, context);
    const socialAccountId = await storeConnectedAccount(stateRow.account_id, adapter.platform, result);
    return { status: "connected", socialAccountId };
  }

  // The authorization code is single-use, so exchange it now. But do NOT save
  // the account yet: hold the login server-side and make the customer confirm
  // which account this is. The state row is kept (it is the confirmation's
  // handle and its 15-minute timeout); it is deleted on confirm or cancel.
  let held: OAuthExchangeResult;
  try {
    held = await adapter.exchangeCode(code, stateRow.pkce_verifier ?? undefined, context);
  } catch (err) {
    await supabase.from("oauth_states").delete().eq("id", state);
    throw err;
  }
  const { data: heldVaultId, error: heldVaultError } = await supabase.rpc("store_social_token", {
    p_token: JSON.stringify({ [CONFIRM_PAYLOAD_MARKER]: true, result: held }),
  });
  if (heldVaultError) {
    await supabase.from("oauth_states").delete().eq("id", state);
    throw heldVaultError;
  }
  const options: ConnectOption[] = [{ id: held.platformAccountId, name: held.displayName || held.platformAccountId }];
  const { error: holdError } = await supabase
    .from("oauth_states")
    .update({ pending_options: options, pending_token_vault_id: heldVaultId })
    .eq("id", state);
  if (holdError) throw holdError;
  return { status: "needs_selection", selectionToken: state, options };
}

/** Reads back the pending Page/account options for a "needs_selection"
 *  connect, scoped to the LazyRelay account that started the flow (so one
 *  customer can never read or complete another's in-flight connect). */
export async function getPendingSelection(
  selectionToken: string,
  accountId: string | undefined,
  registry?: PlatformAdapterRegistry,
): Promise<{ platform: string; options: ConnectOption[]; singleSelection: boolean }> {
  const { data: stateRow, error } = await supabase
    .from("oauth_states")
    .select("account_id, platform, expires_at, pending_options")
    .eq("id", selectionToken)
    .single();
  if (error || !stateRow || !stateRow.pending_options) {
    throw new Error("Invalid or already-used selection link");
  }
  if (stateRow.account_id !== accountId) {
    throw new Error("Not authorized for this selection");
  }
  if (new Date(stateRow.expires_at) < new Date()) {
    await supabase.from("oauth_states").delete().eq("id", selectionToken);
    throw new Error("Selection expired — please reconnect");
  }
  return {
    platform: stateRow.platform,
    options: stateRow.pending_options as ConnectOption[],
    singleSelection: !!registry?.get(stateRow.platform)?.singleSelection,
  };
}

/** Finishes a "needs_selection" connect once the customer has picked one OR
 *  MORE of the options getPendingSelection returned — a customer managing
 *  several Pages can connect all of them in one pass instead of repeating
 *  the whole OAuth round-trip per Page. One-time use like the main
 *  callback: the state row (and the held user token with it) is deleted
 *  regardless of outcome, so a partial failure partway through the list
 *  can't be silently retried against a stale token — the customer just
 *  reconnects. Returns one social_accounts id per successfully connected
 *  option, in the same order as selectedIds. */
export async function finalizeConnectSelection(
  selectionToken: string,
  selectedIds: string[],
  accountId: string | undefined,
  registry: PlatformAdapterRegistry,
  finalizeOptions: { warmedUp?: boolean } = {},
): Promise<string[]> {
  if (selectedIds.length === 0) {
    throw new Error("Pick at least one account to connect");
  }

  const { data: stateRow, error } = await supabase
    .from("oauth_states")
    .select("account_id, platform, expires_at, pending_options, pending_token_vault_id")
    .eq("id", selectionToken)
    .single();

  // Delete immediately, before doing anything else — one-time use no
  // matter what happens next, success or failure.
  await supabase.from("oauth_states").delete().eq("id", selectionToken);

  if (error || !stateRow || !stateRow.pending_token_vault_id) {
    throw new Error("Invalid or already-used selection link");
  }
  if (stateRow.account_id !== accountId) {
    throw new Error("Not authorized for this selection");
  }
  if (new Date(stateRow.expires_at) < new Date()) {
    throw new Error("Selection expired — please reconnect");
  }
  const options = (stateRow.pending_options ?? []) as ConnectOption[];
  const validIds = new Set(options.map((o) => o.id));
  const unknownId = selectedIds.find((id) => !validIds.has(id));
  if (unknownId) {
    throw new Error("That option wasn't part of the original list — please reconnect");
  }

  const adapter = resolveAdapter(registry, stateRow.platform);
  if (adapter.singleSelection && selectedIds.length > 1) {
    throw new Error("Pick just one. To connect another, connect this platform again.");
  }

  const { data: userToken, error: tokenError } = await supabase.rpc("read_social_token", {
    p_vault_id: stateRow.pending_token_vault_id,
  });
  if (tokenError || !userToken) throw tokenError ?? new Error("Could not retrieve the pending token");

  // A confirmation (not a Page/channel pick): the customer approved the one
  // account whose login we were holding. Store it exactly as a direct connect
  // would have, then scrub the held copy.
  const confirmed = parseConfirmPayload(userToken as string);
  if (confirmed) {
    const socialAccountId = await storeConnectedAccount(stateRow.account_id, adapter.platform, confirmed);
    await scrubHeldToken(stateRow.pending_token_vault_id);
    await recordWarmupConfirmation(adapter.platform, [socialAccountId], finalizeOptions.warmedUp === true);
    return [socialAccountId];
  }

  if (!adapter.finalizeConnectOption) {
    throw new Error("This platform doesn't support selection");
  }

  const socialAccountIds: string[] = [];
  try {
    for (const selectedId of selectedIds) {
      const result = await adapter.finalizeConnectOption(userToken, selectedId);
      const socialAccountId = await storeConnectedAccount(stateRow.account_id, adapter.platform, result);
      socialAccountIds.push(socialAccountId);
    }
  } finally {
    // The state row is already gone, so nothing would ever clean up the held login: overwrite it now (the real
    // token has been copied into its own Vault entry by storeConnectedAccount).
    await scrubHeldToken(stateRow.pending_token_vault_id);
  }
  await recordWarmupConfirmation(adapter.platform, socialAccountIds, finalizeOptions.warmedUp === true);
  return socialAccountIds;
}

/** Overwrites a held (not yet confirmed) login in Vault so an unused platform
 *  token does not linger after the customer cancels or confirms. Best effort:
 *  a failure here must never block the customer, the row is already gone. */
async function scrubHeldToken(vaultId: string): Promise<void> {
  try {
    await supabase.rpc("update_social_token", { p_vault_id: vaultId, p_new_token: "discarded" });
  } catch (err) {
    console.error("[connect] could not scrub held token:", err instanceof Error ? err.message : err);
  }
}

/** The customer chose not to connect after seeing which account it was.
 *  Deletes the in-flight connect and scrubs the held login, scoped to the
 *  LazyRelay account that started the flow. Idempotent for a token that is
 *  already gone. */
export async function cancelConnectSelection(selectionToken: string, accountId: string | undefined): Promise<void> {
  const { data: stateRow, error: readError } = await supabase
    .from("oauth_states")
    .select("account_id, pending_token_vault_id")
    .eq("id", selectionToken)
    .maybeSingle();
  if (readError) throw readError;
  if (!stateRow) {
    console.log(`[connect] cancel ${selectionToken.slice(0, 8)}: nothing to cancel (already gone)`);
    return;
  }
  if (stateRow.account_id !== accountId) {
    throw new Error("Not authorized for this selection");
  }
  const { error: deleteError } = await supabase.from("oauth_states").delete().eq("id", selectionToken);
  // A cancel that did not really remove the held login must not look like it did.
  if (deleteError) throw deleteError;
  if (stateRow.pending_token_vault_id) await scrubHeldToken(stateRow.pending_token_vault_id);
  console.log(`[connect] cancel ${selectionToken.slice(0, 8)}: removed and scrubbed`);
}

/** Wipes connect flows nobody finished. A customer who closes the tab at the
 *  confirmation screen leaves a held platform login behind; once the flow's
 *  15-minute window has passed nothing can use it, so scrub it and delete the
 *  row. Only ever touches EXPIRED rows, never a flow still in progress. Runs
 *  with the token job (index.ts). Returns how many rows were cleaned. */
export async function purgeExpiredConnects(now: number = Date.now()): Promise<number> {
  const { data, error } = await supabase
    .from("oauth_states")
    .select("id, pending_token_vault_id")
    .lt("expires_at", new Date(now).toISOString())
    .limit(200);
  if (error) throw error;
  let cleaned = 0;
  for (const row of data ?? []) {
    if (row.pending_token_vault_id) await scrubHeldToken(row.pending_token_vault_id);
    const { error: deleteError } = await supabase.from("oauth_states").delete().eq("id", row.id);
    if (!deleteError) cleaned += 1;
  }
  return cleaned;
}

/** Pinterest only. The customer said at the confirmation step that this
 *  account is already warmed up (they posted by hand first, as the connect
 *  popup advises), so it skips the new-account ramp (pinterestWarmup.ts). An
 *  unticked box changes nothing: the ramp applies from the connection date,
 *  and reconnecting an existing account never resets it. */
async function recordWarmupConfirmation(platform: string, socialAccountIds: string[], warmedUp: boolean): Promise<void> {
  if (platform !== "pinterest" || !warmedUp || socialAccountIds.length === 0) return;
  const { error } = await supabase
    .from("social_accounts")
    .update({ pinterest_warmup_confirmed_at: new Date().toISOString() })
    .in("id", socialAccountIds);
  if (error) console.error("[connect] could not record the warm-up confirmation:", error.message);
}
