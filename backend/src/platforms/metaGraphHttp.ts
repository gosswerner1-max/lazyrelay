// The two things every Facebook and Instagram Graph call needs: a ceiling on how long it may take, and a clear error when the
// body is not JSON (a gateway page, an empty reply) instead of an unhandled parse error. Calls whose bodies already tolerate a
// bad reply (.json().catch(() => ({}))) keep doing that.

/** Generous on purpose: media is fetched by Meta from a URL during the call and can take a while. A hung connection must not wait forever. */
export const GRAPH_REQUEST_TIMEOUT_MS = 120_000;

export function graphFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS) });
}

export async function readGraphJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`Meta sent back a reply we could not read (HTTP ${res.status}). Please try again in a moment.`);
  }
}
