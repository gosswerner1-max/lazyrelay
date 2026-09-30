import { supabase } from "./supabase.js";
import { getRolling24hPostLimit, pinterestLimitForAge, type EffectiveLimit } from "./platformPostLimits.js";

// Resolves the daily post limit that applies to ONE connected account at ONE
// moment. Non-Pinterest platforms just get their normal cap (or none). For
// Pinterest, a brand-new connection follows the warm-up ramp until the
// customer has confirmed it is already warmed up, or about 2 weeks have passed.
//
// Failing open on purpose: if the account row can't be read, the normal cap
// still applies. A ramp lookup problem must never block posting outright.
// Kill switch: PINTEREST_WARMUP_RAMP=off turns the ramp off with no deploy.

export interface WarmupState {
  connectedAt: Date | null;
  confirmed: boolean;
}

export async function loadWarmupState(socialAccountId: string): Promise<WarmupState> {
  try {
    const { data } = await supabase
      .from("social_accounts")
      .select("connected_at, pinterest_warmup_confirmed_at")
      .eq("id", socialAccountId)
      .maybeSingle();
    if (!data) return { connectedAt: null, confirmed: true };
    return {
      connectedAt: data.connected_at ? new Date(data.connected_at as string) : null,
      confirmed: !!data.pinterest_warmup_confirmed_at,
    };
  } catch (err) {
    console.warn("[pinterestWarmup] could not read the account, using the normal cap:", err instanceof Error ? err.message : err);
    return { connectedAt: null, confirmed: true };
  }
}

/** Pure given a loaded state: the limit at time `at`, or null for a platform with no cap. */
export function effectiveLimitAt(platform: string, state: WarmupState, at: Date): EffectiveLimit | null {
  const full = getRolling24hPostLimit(platform);
  if (full === null) return null;
  if (platform !== "pinterest" || process.env.PINTEREST_WARMUP_RAMP === "off") {
    return { limit: full, fullLimit: full, warmingUp: false, warmupEndsAt: null };
  }
  return pinterestLimitForAge(full, state.connectedAt, state.confirmed, at);
}

export async function resolvePostLimitAt(socialAccountId: string, platform: string, at: Date): Promise<EffectiveLimit | null> {
  if (getRolling24hPostLimit(platform) === null) return null;
  if (platform !== "pinterest") return effectiveLimitAt(platform, { connectedAt: null, confirmed: true }, at);
  return effectiveLimitAt(platform, await loadWarmupState(socialAccountId), at);
}
