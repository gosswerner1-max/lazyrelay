// Database cache of the per-instance Mastodon app registration (table mastodon_apps, migration 0110).
// The client secret is kept in Vault: the table only holds the Vault id. supabase is imported
// lazily so adapter code that never reaches a customer-chosen instance never loads it.

export interface MastodonAppRecord {
  clientId: string;
  clientSecret: string;
}

async function db() {
  return (await import("../supabase.js")).supabase;
}

async function readSecret(vaultId: string): Promise<string | null> {
  const supabase = await db();
  const { data, error } = await supabase.rpc("read_social_token", { p_vault_id: vaultId });
  return error || typeof data !== "string" || !data ? null : data;
}

/** The cached registration for an instance, or null when there is none, when it was made for a
 *  different redirect URI (the caller must register again) or when its secret cannot be read. */
export async function loadMastodonApp(instance: string, redirectUri: string): Promise<MastodonAppRecord | null> {
  const supabase = await db();
  const { data, error } = await supabase
    .from("mastodon_apps")
    .select("client_id, client_secret_vault_id, redirect_uri")
    .eq("instance", instance)
    .maybeSingle();
  if (error || !data) return null;
  if (data.redirect_uri !== redirectUri) return null;
  const secret = await readSecret(data.client_secret_vault_id as string);
  if (!secret) return null;
  return { clientId: data.client_id as string, clientSecret: secret };
}

/** Saves a fresh registration. Returns the record that is now the stored one. An existing row is
 *  replaced only when it was made for a different redirect URI, or when its secret is truly
 *  unreadable (two attempts): one failed read must never throw away a healthy registration. When
 *  two backends register the same instance at the same moment the first one wins and the loser
 *  adopts it. */
export async function saveMastodonApp(instance: string, redirectUri: string, app: MastodonAppRecord): Promise<MastodonAppRecord> {
  const supabase = await db();

  const { data: existing } = await supabase
    .from("mastodon_apps")
    .select("client_id, client_secret_vault_id, redirect_uri")
    .eq("instance", instance)
    .maybeSingle();

  if (existing && existing.redirect_uri === redirectUri) {
    const oldVaultId = existing.client_secret_vault_id as string;
    const secret = (await readSecret(oldVaultId)) ?? (await readSecret(oldVaultId));
    if (secret) return { clientId: existing.client_id as string, clientSecret: secret };
  }

  const { data: vaultId, error: vaultError } = await supabase.rpc("store_social_token", { p_token: app.clientSecret });
  if (vaultError || !vaultId) throw new Error("Could not save the Mastodon app registration");

  if (existing) {
    const oldVaultId = existing.client_secret_vault_id as string;
    const { error } = await supabase
      .from("mastodon_apps")
      .update({ client_id: app.clientId, client_secret_vault_id: vaultId, redirect_uri: redirectUri, created_at: new Date().toISOString() })
      .eq("instance", instance);
    if (error) throw new Error("Could not save the Mastodon app registration");
    await scrub(oldVaultId);
    return app;
  }

  const { error: insertError } = await supabase
    .from("mastodon_apps")
    .insert({ instance, client_id: app.clientId, client_secret_vault_id: vaultId, redirect_uri: redirectUri });
  if (!insertError) return app;

  // Lost a race (unique violation): use whatever the winner stored.
  await scrub(vaultId as string);
  const winner = await loadMastodonApp(instance, redirectUri);
  if (winner) return winner;
  throw new Error("Could not save the Mastodon app registration");
}

/** Forgets an instance's registration (the instance says the app no longer exists). */
export async function deleteMastodonApp(instance: string): Promise<void> {
  const supabase = await db();
  const { data } = await supabase.from("mastodon_apps").select("client_secret_vault_id").eq("instance", instance).maybeSingle();
  await supabase.from("mastodon_apps").delete().eq("instance", instance);
  if (data?.client_secret_vault_id) await scrub(data.client_secret_vault_id as string);
}

async function scrub(vaultId: string): Promise<void> {
  try {
    const supabase = await db();
    await supabase.rpc("update_social_token", { p_vault_id: vaultId, p_new_token: "discarded" });
  } catch {
    // Best effort: the old secret belongs to an app nobody uses any more.
  }
}
