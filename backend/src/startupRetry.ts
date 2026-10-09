// Retries a startup check with exponential back-off instead of failing on the
// first error. Real incident, 2026-10-08: the Render backend (Oregon) briefly
// could not reach Supabase (Ireland); the startup check quit with exit(1) on
// the first failed call, so every restart died again (7 restarts, about 11
// minutes down) long after the network had recovered.
export async function retryStartupCheck(
  check: () => Promise<{ ok: boolean; error?: unknown }>,
  opts: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onFailure?: (attempt: number, total: number, error: unknown, nextDelayMs: number | null) => void;
  } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 8;
  const baseDelayMs = opts.baseDelayMs ?? 2_000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let result: { ok: boolean; error?: unknown };
    try {
      result = await check();
    } catch (err) {
      result = { ok: false, error: err };
    }
    if (result.ok) return true;
    const delay = attempt < attempts ? Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs) : null;
    opts.onFailure?.(attempt, attempts, result.error, delay);
    if (delay !== null) await sleep(delay);
  }
  return false;
}
