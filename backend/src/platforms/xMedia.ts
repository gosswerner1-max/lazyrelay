// X media upload with a customer's own OAuth 1.0a keys. TWO candidate flows sit behind ONE selector, because it is not
// yet verified which one X accepts for 1.0a user keys (see the BYOK architecture note, section 0):
//
//   "v2"  POST   https://api.x.com/2/media/upload/initialize          (JSON body)
//         POST   https://api.x.com/2/media/upload/{id}/append         (multipart, segments)
//         POST   https://api.x.com/2/media/upload/{id}/finalize
//         GET    https://api.x.com/2/media/upload?command=STATUS&media_id={id}
//   "v1"  the older chunked flow on https://upload.twitter.com/1.1/media/upload.json
//         (command=INIT, APPEND, FINALIZE, STATUS)
//
// X_MEDIA_FLOW below is the selector. It is "v2" until scripts/live-x-byok-probe.ts has been run with real keys and
// reported which flow works; then change this one constant. Both flows are signed with OAuth 1.0a; the JSON, multipart
// and octet bodies are not part of the signature (oauth1.ts), only the query string is.

import { createXSignedFetch, describeXFailure, readJson, readXError, X_API_BASE, type XErrorInfo, type XSignedFetch } from "./xApi.js";
import type { XByokBundle } from "./xByok.js";

export type XMediaFlow = "v2" | "v1";

/** THE selector. Default v2; flip to "v1" only after the live probe says v2 refuses 1.0a keys and v1.1 works. */
export const X_MEDIA_FLOW: XMediaFlow = "v2";

export const V1_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";
export const V2_UPLOAD_URL = `${X_API_BASE}/2/media/upload`;

/** Size of one APPEND segment. X accepts up to 5 MB (v1.1) and 8 MB (v2) per segment; 4 MB is safe for both. */
export const MEDIA_SEGMENT_BYTES = 4 * 1024 * 1024;
const PROCESSING_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 3_000;
const MAX_POLL_MS = 10_000;

export interface XMediaInput {
  bytes: Buffer;
  mimeType: string;
}

export interface XMediaStep {
  step: string;
  ok: boolean;
  status: number | null;
  error: XErrorInfo | null;
}

export type XMediaResult =
  | { ok: true; mediaId: string; steps: XMediaStep[] }
  | { ok: false; mediaId: null; failedStep: string; /** Compact, classifiable text, no secrets. */ errorMessage: string; steps: XMediaStep[] };

export interface XMediaUploader {
  readonly flow: XMediaFlow;
  upload(media: XMediaInput): Promise<XMediaResult>;
}

export interface XMediaUploaderOptions {
  /** Wait between status polls. Tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
  /** Replaces global fetch (tests, the live probe). */
  fetchImpl?: typeof fetch;
}

export function mediaCategoryFor(mimeType: string): "tweet_image" | "tweet_gif" | "tweet_video" {
  if (mimeType === "image/gif") return "tweet_gif";
  if (mimeType.startsWith("video/")) return "tweet_video";
  return "tweet_image";
}

interface ProcessingInfo {
  state?: string;
  check_after_secs?: number;
}

/** Both flows answer either {data:{...}} (v2) or a bare object (v1.1); this reads whichever it gets. */
function unwrap(body: unknown): Record<string, unknown> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const data = b.data && typeof b.data === "object" ? (b.data as Record<string, unknown>) : null;
  return data ?? b;
}

function mediaIdOf(body: unknown): string | null {
  const u = unwrap(body);
  for (const k of ["id", "media_id_string", "media_id"]) {
    const v = u[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

export function createXMediaUploader(flow: XMediaFlow, bundle: XByokBundle, options: XMediaUploaderOptions = {}): XMediaUploader {
  const signed: XSignedFetch = createXSignedFetch(bundle, options.fetchImpl);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    flow,
    async upload(media: XMediaInput): Promise<XMediaResult> {
      const steps: XMediaStep[] = [];
      const fail = (step: string, res: Response | null, body: unknown, fallback: string): XMediaResult => {
        steps.push({ step, ok: false, status: res?.status ?? null, error: res ? readXError(body) : null });
        return { ok: false, mediaId: null, failedStep: step, errorMessage: res ? `media ${step}: ${describeXFailure(res, body, bundle)}` : `media ${step}: ${fallback}`, steps };
      };
      const pass = (step: string, res: Response) => steps.push({ step, ok: true, status: res.status, error: null });

      const isV2 = flow === "v2";
      const initUrl = (): string => {
        if (isV2) return `${V2_UPLOAD_URL}/initialize`;
        const q = new URLSearchParams({ command: "INIT", total_bytes: String(media.bytes.length), media_type: media.mimeType, media_category: mediaCategoryFor(media.mimeType) });
        return `${V1_UPLOAD_URL}?${q.toString()}`;
      };

      // 1. INIT / initialize
      let initRes: Response;
      try {
        initRes = await signed(
          isV2
            ? { method: "POST", url: initUrl(), json: { media_type: media.mimeType, total_bytes: media.bytes.length, media_category: mediaCategoryFor(media.mimeType) } }
            : { method: "POST", url: initUrl() },
        );
      } catch {
        return fail("initialize", null, null, "could not reach X");
      }
      const initBody = await readJson(initRes);
      const mediaId = initRes.ok ? mediaIdOf(initBody) : null;
      if (!initRes.ok || !mediaId) return fail("initialize", initRes, initBody, "X did not return a media id");
      pass("initialize", initRes);

      // 2. APPEND, one request per segment
      const segments = Math.max(1, Math.ceil(media.bytes.length / MEDIA_SEGMENT_BYTES));
      for (let i = 0; i < segments; i++) {
        const chunk = media.bytes.subarray(i * MEDIA_SEGMENT_BYTES, (i + 1) * MEDIA_SEGMENT_BYTES);
        const form = new FormData();
        if (!isV2) {
          form.append("command", "APPEND");
          form.append("media_id", mediaId);
        }
        form.append("segment_index", String(i));
        form.append("media", new Blob([new Uint8Array(chunk)], { type: media.mimeType }));
        let appendRes: Response;
        try {
          appendRes = await signed({ method: "POST", url: isV2 ? `${V2_UPLOAD_URL}/${encodeURIComponent(mediaId)}/append` : V1_UPLOAD_URL, multipart: form });
        } catch {
          return fail("append", null, null, "could not reach X");
        }
        if (!appendRes.ok) return fail("append", appendRes, await readJson(appendRes), "");
        if (i === segments - 1) pass("append", appendRes);
      }

      // 3. FINALIZE
      let finalRes: Response;
      try {
        finalRes = await signed(
          isV2
            ? { method: "POST", url: `${V2_UPLOAD_URL}/${encodeURIComponent(mediaId)}/finalize` }
            : { method: "POST", url: `${V1_UPLOAD_URL}?${new URLSearchParams({ command: "FINALIZE", media_id: mediaId }).toString()}` },
        );
      } catch {
        return fail("finalize", null, null, "could not reach X");
      }
      const finalBody = await readJson(finalRes);
      if (!finalRes.ok) return fail("finalize", finalRes, finalBody, "");
      pass("finalize", finalRes);

      // 4. STATUS polling, only when X says the media is still being processed (video, GIF)
      let info = unwrap(finalBody).processing_info as ProcessingInfo | undefined;
      const needsPolling = !!info;
      const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
      while (info && info.state !== "succeeded") {
        if (info.state === "failed") return fail("status", null, null, "X could not process the media");
        if (Date.now() >= deadline) return fail("status", null, null, "X did not finish processing the media in time");
        await sleep(Math.min(MAX_POLL_MS, Math.max(1, info.check_after_secs ?? 0) * 1000 || DEFAULT_POLL_MS));
        const statusUrl = isV2
          ? `${V2_UPLOAD_URL}?${new URLSearchParams({ command: "STATUS", media_id: mediaId }).toString()}`
          : `${V1_UPLOAD_URL}?${new URLSearchParams({ command: "STATUS", media_id: mediaId }).toString()}`;
        let statusRes: Response;
        try {
          statusRes = await signed({ method: "GET", url: statusUrl });
        } catch {
          return fail("status", null, null, "could not reach X");
        }
        const statusBody = await readJson(statusRes);
        if (!statusRes.ok) return fail("status", statusRes, statusBody, "");
        info = unwrap(statusBody).processing_info as ProcessingInfo | undefined;
        if (!info) break; // processing_info gone: nothing left to wait for
      }
      if (needsPolling) steps.push({ step: "status", ok: true, status: 200, error: null });
      return { ok: true, mediaId, steps };
    },
  };
}
