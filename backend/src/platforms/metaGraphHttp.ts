// What every Facebook and Instagram Graph call needs: a clear error when the body is not JSON (a gateway page, an empty reply)
// instead of an unhandled parse error, and, for connect, token-exchange and read calls, a ceiling on how long they may take.
// Publish and upload calls get NO ceiling (graphPublishFetch). Calls whose bodies already tolerate a bad reply
// (.json().catch(() => ({}))) keep doing that.

/** For connect, token-exchange and read calls: a hung connection must not wait forever. */
export const GRAPH_REQUEST_TIMEOUT_MS = 120_000;

export function graphFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS) });
}

/**
 * For calls that publish or upload (/feed, /photos, /videos, /media, /media_publish, the *_stories calls and the video upload_url).
 * No client timeout on purpose: Meta fetches the media from our URL during these calls and can accept the post even after we stop
 * waiting, and an abort at that point makes the scheduler retry and post twice. A genuinely hung call is recovered by the
 * scheduler's stuck-post recovery, which checks the platform before re-sending.
 */
export function graphPublishFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, init);
}

export async function readGraphJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`Meta sent back a reply we could not read (HTTP ${res.status}). Please try again in a moment.`);
  }
}
