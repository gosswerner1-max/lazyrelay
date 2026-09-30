// The per-instance Mastodon app cache: the secret lives in (fake) Vault, the table holds only its id,
// and a changed redirect URI forces a fresh registration. supabase is an in-memory fake.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tables, vault } from "../testFakeSupabase.js";

const flaky = vi.hoisted(() => ({ failReads: 0 }));
vi.mock("../supabase.js", async () => {
  const f = await import("../testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => f.makeBuilder(t),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "read_social_token" && flaky.failReads > 0) {
          flaky.failReads -= 1;
          return { data: null, error: { message: "transient" } };
        }
        return f.fakeRpc(fn, args);
      },
    },
  };
});

const { loadMastodonApp, saveMastodonApp, deleteMastodonApp } = await import("./mastodonApps.js");

const INSTANCE = "https://hachyderm.io";
const CB = "https://api.example.org/cb";
const SECRET = "client-secret-value-456";

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vault.clear();
  flaky.failReads = 0;
});

describe("mastodon_apps cache", () => {
  it("returns null when the instance was never registered", async () => {
    expect(await loadMastodonApp(INSTANCE, CB)).toBeNull();
  });

  it("stores the secret in Vault only, never in the table, and reads it back", async () => {
    const saved = await saveMastodonApp(INSTANCE, CB, { clientId: "cid", clientSecret: SECRET });
    expect(saved).toEqual({ clientId: "cid", clientSecret: SECRET });
    expect(JSON.stringify(tables.mastodon_apps)).not.toContain(SECRET);
    expect(tables.mastodon_apps).toHaveLength(1);
    expect(tables.mastodon_apps[0]).toMatchObject({ instance: INSTANCE, client_id: "cid", redirect_uri: CB });
    expect([...vault.values()]).toContain(SECRET);
    expect(await loadMastodonApp(INSTANCE, CB)).toEqual({ clientId: "cid", clientSecret: SECRET });
  });

  it("a registration made for another redirect URI is not reused", async () => {
    await saveMastodonApp(INSTANCE, CB, { clientId: "cid", clientSecret: SECRET });
    expect(await loadMastodonApp(INSTANCE, "https://api.example.org/new-cb")).toBeNull();
  });

  it("re-registering replaces the row and scrubs the old secret", async () => {
    await saveMastodonApp(INSTANCE, CB, { clientId: "old", clientSecret: SECRET });
    const oldVaultId = tables.mastodon_apps[0].client_secret_vault_id as string;
    await saveMastodonApp(INSTANCE, "https://api.example.org/new-cb", { clientId: "new", clientSecret: "second-secret" });
    expect(tables.mastodon_apps).toHaveLength(1);
    expect(tables.mastodon_apps[0]).toMatchObject({ client_id: "new", redirect_uri: "https://api.example.org/new-cb" });
    expect(vault.get(oldVaultId)).toBe("discarded");
    expect(await loadMastodonApp(INSTANCE, "https://api.example.org/new-cb")).toEqual({ clientId: "new", clientSecret: "second-secret" });
  });

  it("one failed secret read does not overwrite or scrub a healthy row", async () => {
    await saveMastodonApp(INSTANCE, CB, { clientId: "cid", clientSecret: SECRET });
    const vaultId = tables.mastodon_apps[0].client_secret_vault_id as string;
    flaky.failReads = 1; // the first read inside save fails, the second succeeds
    const r = await saveMastodonApp(INSTANCE, CB, { clientId: "other", clientSecret: "other-secret" });
    expect(r).toEqual({ clientId: "cid", clientSecret: SECRET }); // adopts the healthy one
    expect(tables.mastodon_apps).toHaveLength(1);
    expect(tables.mastodon_apps[0]).toMatchObject({ client_id: "cid", client_secret_vault_id: vaultId });
    expect(vault.get(vaultId)).toBe(SECRET);
  });

  it("a secret that stays unreadable on both attempts is replaced", async () => {
    await saveMastodonApp(INSTANCE, CB, { clientId: "cid", clientSecret: SECRET });
    flaky.failReads = 2;
    const r = await saveMastodonApp(INSTANCE, CB, { clientId: "new", clientSecret: "second-secret" });
    expect(r).toEqual({ clientId: "new", clientSecret: "second-secret" });
    expect(tables.mastodon_apps[0]).toMatchObject({ client_id: "new" });
  });

  it("deleteMastodonApp removes the row and scrubs its secret", async () => {
    await saveMastodonApp(INSTANCE, CB, { clientId: "cid", clientSecret: SECRET });
    const vaultId = tables.mastodon_apps[0].client_secret_vault_id as string;
    await deleteMastodonApp(INSTANCE);
    expect(tables.mastodon_apps).toHaveLength(0);
    expect(vault.get(vaultId)).toBe("discarded");
  });

  it("an unreadable secret counts as not cached", async () => {
    await saveMastodonApp(INSTANCE, CB, { clientId: "cid", clientSecret: SECRET });
    vault.clear();
    expect(await loadMastodonApp(INSTANCE, CB)).toBeNull();
  });
});
