// SELF_HEALING_MODE: off (the default), shadow or on. Anything other than the exact words "shadow" or "on" means off, so a typo
// can never switch the new behaviour on. Read at call time so a restart with a new value is all that is needed.

export type SelfHealingMode = "off" | "shadow" | "on";

export function selfHealingMode(env: Record<string, string | undefined> = process.env): SelfHealingMode {
  const raw = env.SELF_HEALING_MODE;
  return raw === "shadow" || raw === "on" ? raw : "off";
}
