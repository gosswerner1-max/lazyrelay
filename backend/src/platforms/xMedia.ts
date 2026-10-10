// X media upload with a customer's own OAuth 1.0a keys. TWO candidate flows sit behind ONE selector, because it is not
// yet verified which one X accepts for 1.0a user keys (see the BYOK architecture note, section 0):
//
//   "v2"  POST   https://api.x.com/2/media/upload/initialize          (JSON body)
//         POST   https://api.x.com/2/media/upload/{id}/append         (multipart, segments)
//         POST   https://api.x.com/2/media/upload/{id}/finalize
//         GET    https://api.x.com/2/media/upload?command=STATUS&media_id={id}
//   "v1.1" the older chunked flow on https://upload.twitter.com/1.1/media/upload.json
//         (command=INIT, APPEND, FINALIZE, STATUS)
//
// X_MEDIA_UPLOAD_CONFIG.flow below is the selector. It stays "v2" until scripts/live-x-byok-probe.ts has been run with
// real keys and reported which flow works; then change that one field. Both flows are signed with OAuth 1.0a; the JSON, multipart
// and octet bodies are not part of the signature (oauth1.ts), only the query string is.

import { createXSignedFetch, describeXFailure, readJson, readXError, X_API_BASE, type XErrorInfo, type XSignedFetch } from "./xApi.js";
import type { XByokBundle } from "./xByok.js";

export type XMediaFlow = "v2" | "v1.1";

export interface XMediaUploadConfig {
  /** THE selector. */
  flow: XMediaFlow;
  /** v2 base, e.g. https://api.x.com/2/media/upload (initialize, {id}/append, {id}/finalize, ?command=STATUS). */
  v2Url: string;
  /** v1.1 endpoint (command=INIT, APPEND, FINALIZE, STATUS). */
  v1Url: string;
  /** Size of one APPEND segment. */
  maxSegmentBytes: number;
  /** Status polls before giving up on processing (video, GIF). */
  statusPollMaxAttempts: number;
  /** Wait between status polls. */
  statusPollIntervalMs: number;
}

// PLACEHOLDER: unverified against live X with OAuth 1.0a, see project-x-byok-architecture note (section 0). Neither flow is
// proven to accept a customer's 1.0a user keys; both are implemented and unit-tested against mocks only. Do not treat
// either as working until the live probe has reported.
export const X_MEDIA_UPLOAD_CONFIG: XMediaUploadConfig = {
  flow: "v2",
  v2Url: `${X_API_BASE}/2/media/upload`,
  v1Url: "https://upload.twitter.com/1.1/media/upload.json",
  maxSegmentBytes: 8_388_608,
  statusPollMaxAttempts: 20,
  statusPollIntervalMs: 3_000,
};

export const V1_UPLOAD_URL = X_MEDIA_UPLOAD_CONFIG.v1Url;
export const V2_UPLOAD_URL = X_MEDIA_UPLOAD_CONFIG.v2Url;
export const MEDIA_SEGMENT_BYTES = X_MEDIA_UPLOAD_CONFIG.maxSegmentBytes;

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
  /** Overrides parts of X_MEDIA_UPLOAD_CONFIG (tests use a tiny segment size). */
  config?: Partial<XMediaUploadConfig>;
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
  const cfg: XMediaUploadConfig = { ...X_MEDIA_UPLOAD_CONFIG, ...options.config };
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
        if (isV2) return `${cfg.v2Url}/initialize`;
        const q = new URLSearchParams({ command: "INIT", total_bytes: String(media.bytes.length), media_type: media.mimeType, media_category: mediaCategoryFor(media.mimeType) });
        return `${cfg.v1Url}?${q.toString()}`;
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
      const segments = Math.max(1, Math.ceil(media.bytes.length / cfg.maxSegmentBytes));
      for (let i = 0; i < segments; i++) {
        const chunk = media.bytes.subarray(i * cfg.maxSegmentBytes, (i + 1) * cfg.maxSegmentBytes);
        const form = new FormData();
        if (!isV2) {
          form.append("command", "APPEND");
          form.append("media_id", mediaId);
        }
        form.append("segment_index", String(i));
        form.append("media", new Blob([new Uint8Array(chunk)], { type: media.mimeType }));
        let appendRes: Response;
        try {
          appendRes = await signed({ method: "POST", url: isV2 ? `${cfg.v2Url}/${encodeURIComponent(mediaId)}/append` : cfg.v1Url, multipart: form });
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
            ? { method: "POST", url: `${cfg.v2Url}/${encodeURIComponent(mediaId)}/finalize` }
            : { method: "POST", url: `${cfg.v1Url}?${new URLSearchParams({ command: "FINALIZE", media_id: mediaId }).toString()}` },
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
      let attempts = 0;
      while (info && info.state !== "succeeded") {
        if (info.state === "failed") return fail("status", null, null, "X could not process the media");
        if (attempts >= cfg.statusPollMaxAttempts) return fail("status", null, null, "X did not finish processing the media in time");
        attempts += 1;
        await sleep(cfg.statusPollIntervalMs);
        const statusUrl = isV2
          ? `${cfg.v2Url}?${new URLSearchParams({ command: "STATUS", media_id: mediaId }).toString()}`
          : `${cfg.v1Url}?${new URLSearchParams({ command: "STATUS", media_id: mediaId }).toString()}`;
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
