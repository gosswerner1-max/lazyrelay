import { supabase } from "../supabase.js";

// One LazyRelay account may start connects to only a few DIFFERENT Mastodon servers per day.
// Every new server means LazyRelay registers an app on it (a request to a host the customer
// chose), so this stops the connect path being used to poke at many servers. Retrying the same
// server never counts twice. Backed by mastodon_instance_attempts (migration 0110).

export const MAX_MASTODON_INSTANCES_PER_DAY = 5;
const DAY_MS = 86_400_000;

/** A limit problem the customer can read as is (the route answers 429). */
export class ConnectLimitError extends Error {}

export async function checkMastodonInstanceLimit(accountId: string, instance: string, now: number = Date.now()): Promise<void> {
  const since = new Date(now - DAY_MS).toISOString();
  // Old rows are dead weight: clear them here rather than needing a separate job.
  await supabase.from("mastodon_instance_attempts").delete().eq("account_id", accountId).lt("created_at", since);

  const { data, error } = await supabase
    .from("mastodon_instance_attempts")
    .select("instance")
    .eq("account_id", accountId)
    .gt("created_at", since);
  if (error) throw new Error("Could not start the Mastodon connection. Try again in a moment.");

  const seen = new Set((data ?? []).map((r: { instance: string }) => r.instance));
  if (seen.has(instance)) return;
  if (seen.size >= MAX_MASTODON_INSTANCES_PER_DAY) {
    throw new ConnectLimitError(
      `You can try up to ${MAX_MASTODON_INSTANCES_PER_DAY} different Mastodon servers per day. Try again tomorrow, or use one of the servers you already tried.`,
    );
  }
  const { error: upsertError } = await supabase
    .from("mastodon_instance_attempts")
    .upsert({ account_id: accountId, instance, created_at: new Date(now).toISOString() }, { onConflict: "account_id,instance" });
  if (upsertError) throw new Error("Could not start the Mastodon connection. Try again in a moment.");
}
