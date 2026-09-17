/** Shared outbound media-send helper — built 2026-09-05 to close the
 *  memory-scales-with-file-size risk found across 6 adapters, all of which
 *  did `Buffer.from(await res.arrayBuffer())`: the WHOLE file loaded into
 *  process memory before it's sent anywhere. On a 512MB (now 2GB) Render
 *  instance, that means memory use scales directly with file size times how
 *  many sends are happening at once — see
 *  project-media-pipeline-video-support-2026-09-05 for the full analysis.
 *
 *  The fix: fetch the source media (LazyRelay's own storage, generally) and
 *  pass its response body straight through as the outgoing request's body,
 *  so only a small chunk is ever held in memory at a time — a 10MB file and
 *  a 1GB file cost roughly the same to send.
 *
 *  Two shapes are needed because platforms send media two different ways:
 *  - A raw binary PUT/POST (TikTok, YouTube, LinkedIn, Bluesky) — trivial:
 *    the source stream can be passed directly as the outgoing body.
 *  - multipart/form-data (Mastodon, and Discord/Tumblr when built) — harder:
 *    the standard Blob/FormData APIs need the whole part buffered into a
 *    Blob first, which would silently reintroduce the same problem. This
 *    file builds a real streaming multipart body by hand instead.
 */

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";
import { isSafeMediaUrl } from "../urlSafety.js";

/** Builds a one-off undici Agent whose connect.lookup always answers with
 *  the exact address(es) isSafeMediaUrl already validated, instead of
 *  letting the connection re-resolve the hostname (undici's default
 *  behavior) -- this is what actually pins the fetch below to a known-safe
 *  IP rather than trusting DNS to answer the same way twice. Deliberately
 *  a fresh Agent per call, not a shared module-level one: the pinned
 *  address is only valid for this one already-validated mediaUrl, and
 *  reusing an Agent across different hostnames would either pin the wrong
 *  host or require per-hostname bookkeeping for no real benefit here (this
 *  function is called once per media send, not in a hot loop). */
function pinnedDispatcher(addresses: string[]): Dispatcher {
  const candidates = addresses
    .map((address) => ({ address, family: isIP(address) }))
    .filter((c): c is { address: string; family: 4 | 6 } => c.family === 4 || c.family === 6);

  return new Agent({
    connect: {
      // Node's net.connect calls this with `options.all: true` when
      // autoSelectFamily (Happy Eyeballs) is active -- the default since
      // Node 20 -- which expects the *array* callback form, not the
      // single-address one. Caught live: the single-address form threw
      // "Invalid IP address: undefined" the first time this was actually
      // run, not just typechecked, since Node called this function
      // expecting an array and got a bare string instead. Both forms are
      // handled here so this doesn't silently break if that default
      // setting ever changes back.
      lookup(_hostname, options, callback) {
        if (candidates.length === 0) {
          callback(new Error("no valid pinned address"), "", 0);
          return;
        }
        if (options.all) {
          callback(null, candidates);
        } else {
          callback(null, candidates[0].address, candidates[0].family);
        }
      },
    },
  });
}

export interface FetchedMedia {
  /** The source media's body as a stream. Do NOT call .arrayBuffer() or
   *  .blob() on the response this came from -- that defeats the entire
   *  point of this helper. Pass this straight through as the outgoing
   *  request's body (with `duplex: "half"`, see RequestInitWithDuplex). */
  body: ReadableStream<Uint8Array>;
  /** From the source's Content-Length header; null if it didn't send one
   *  (rare for LazyRelay's own Supabase Storage URLs, but callers that need
   *  a known size -- e.g. a platform's `Content-Length` or `total_bytes`
   *  field -- must handle the null case rather than assume it's always
   *  present). */
  sizeBytes: number | null;
  contentType: string;
}

/** Fetches a source media URL and returns its body as a stream plus
 *  metadata, without buffering it into memory. `redirect: "manual"` is
 *  applied for the same SSRF-closing reason every adapter's own fetch call
 *  already used before this helper existed (see mastodon.ts's original
 *  uploadMedia comment for the full rationale) -- res.ok is false for any
 *  3xx, so the existing null-on-failure convention below still closes it.
 *  Returns null on any failure, matching every adapter's existing
 *  null-on-failure convention for this step.
 *
 *  Re-validates the URL's safety (isSafeMediaUrl) immediately before
 *  fetching, not just once at post-creation time (postCreation.ts's own
 *  validatePostFields) -- real gap found in the 2026-09-06 security audit.
 *  Posts are scheduled ahead of time, sometimes days ahead, so the gap
 *  between the write-time check and this actual fetch is the practically
 *  exploitable window here: a customer controlling their own DNS could
 *  point a hostname at a genuinely public address when the post is
 *  created, then repoint it at an internal/metadata address any time
 *  before the scheduled send. Re-checking right here, at the one shared
 *  choke point every adapter already calls through, closes that window
 *  without needing to touch any of the 9 call sites individually.
 *
 *  Also pins this fetch() to the exact IP isSafeMediaUrl just validated
 *  (via a per-call undici Agent with a custom connect.lookup), rather than
 *  letting fetch() re-resolve the hostname itself -- closes the remaining
 *  DNS-rebinding race (a TTL=0 attacker-controlled record could otherwise
 *  answer differently between the check two lines above and fetch's own
 *  independent lookup, even though the two calls are back-to-back). The
 *  original Host header / TLS SNI still use the real hostname -- only the
 *  raw TCP connection target is pinned, so this works transparently for
 *  any HTTPS host, virtual-hosted or not. */
export async function fetchMediaForStreaming(mediaUrl: string): Promise<FetchedMedia | null> {
  const safety = await isSafeMediaUrl(mediaUrl);
  if (!safety.safe) return null;
  const res = await fetch(mediaUrl, { redirect: "manual", dispatcher: pinnedDispatcher(safety.addresses) } as RequestInitWithDuplex);
  if (!res.ok || !res.body) return null;
  const contentLength = res.headers.get("content-length");
  return {
    body: res.body,
    sizeBytes: contentLength ? Number(contentLength) : null,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

/** Node's fetch requires `duplex: "half"` to send a streaming (ReadableStream)
 *  request body -- without it, fetch throws "RequestInit: duplex option is
 *  required when sending a body." The DOM RequestInit type this project's TS
 *  lib pulls in doesn't declare that field yet, so this is the one, documented
 *  place that gap gets bridged -- no adapter needs its own `as any` for it.
 *  `dispatcher` is the same kind of gap: Node's fetch (undici under the hood)
 *  accepts it to override which Agent/connection a request uses -- used by
 *  fetchMediaForStreaming's own DNS-pinning fetch() call above, not by any
 *  adapter's outgoing upload request, but declared here alongside `duplex`
 *  since both are undici-specific RequestInit extensions the DOM type is
 *  missing. */
export type RequestInitWithDuplex = RequestInit & { duplex?: "half"; dispatcher?: Dispatcher };

interface MultipartPart {
  fieldName: string;
  /** A string field (e.g. "description"), or a file part. `sizeBytes` on a
   *  file part is OPTIONAL but worth setting whenever the caller already
   *  knows it (e.g. from fetchMediaForStreaming's sizeBytes) -- see
   *  buildStreamingMultipartBody's `contentLength` note below for why. */
  value: string | { filename: string; contentType: string; data: ReadableStream<Uint8Array>; sizeBytes?: number | null };
}

/** Builds a real streaming multipart/form-data body: only ever holds one
 *  chunk of the underlying file stream in memory at a time, never the whole
 *  file. Returns the body (pass directly as fetch's `body`, with
 *  `duplex: "half"`) and the exact Content-Type header value to send
 *  alongside it (carries the boundary). */
export interface StreamCursor {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  pending: Uint8Array | null;
}

/** Wraps a source stream in a cursor that createChunkStream() below can pull
 *  from repeatedly, in order, across multiple sequential chunk uploads --
 *  needed for any platform (TikTok above 64MB, X above its own per-segment
 *  max) whose protocol requires one continuous file to be split into several
 *  separate sequential requests. */
export function createStreamCursor(stream: ReadableStream<Uint8Array>): StreamCursor {
  return { reader: stream.getReader(), pending: null };
}

/** Returns a stream yielding exactly `n` bytes pulled from the cursor's
 *  underlying source (or fewer, only if the source itself ends first --
 *  callers that need an exact byte count should track how many bytes they
 *  actually intended to send via their own accounting, e.g. from the known
 *  total file size, not by trusting this always delivers exactly n), then
 *  closes WITHOUT touching the underlying reader further -- the next call
 *  against the same cursor continues right where this one stopped. This is
 *  how one continuous video stream gets split into several sequential
 *  chunk-upload requests without ever buffering more than a single
 *  underlying read()'s worth of data (typically tens of KB) at a time --
 *  memory use here does NOT scale with the chunk size, only with whatever
 *  the network stack itself buffers internally. */
export function createChunkStream(cursor: StreamCursor, n: number): ReadableStream<Uint8Array> {
  let remaining = n;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      let piece: Uint8Array;
      if (cursor.pending) {
        piece = cursor.pending;
        cursor.pending = null;
      } else {
        const { done, value } = await cursor.reader.read();
        if (done) {
          controller.close();
          remaining = 0;
          return;
        }
        piece = value;
      }
      if (piece.byteLength > remaining) {
        controller.enqueue(piece.subarray(0, remaining));
        cursor.pending = piece.subarray(remaining);
        remaining = 0;
        controller.close();
      } else {
        controller.enqueue(piece);
        remaining -= piece.byteLength;
        if (remaining <= 0) controller.close();
      }
    },
  });
}

// CAUGHT LIVE 2026-09-05: some upload endpoints (confirmed on Pinterest's
// S3-style presigned upload) reject a chunked-transfer body outright with
// `411 Length Required` -- they need a real Content-Length header up front,
// which a pure stream of unknown total length can't provide. Since every
// string part's byte length is knowable immediately, and a file part's
// length is knowable whenever the caller passes `sizeBytes` (which costs
// nothing -- it's just the source's own Content-Length, already fetched),
// the total can be computed WITHOUT buffering the file itself.
// `contentLength` comes back `null` only if some part's size genuinely
// isn't known (e.g. a file part with no `sizeBytes`) -- callers whose
// destination requires a real Content-Length (like Pinterest) must not
// proceed with a null value.
export function buildStreamingMultipartBody(parts: MultipartPart[]): {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: number | null;
} {
  const boundary = `LazyRelayFormBoundary${randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();

  let contentLength = 0;
  for (const part of parts) {
    if (typeof part.value === "string") {
      contentLength += encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.fieldName}"\r\n\r\n${part.value}\r\n`,
      ).byteLength;
      continue;
    }
    if (part.value.sizeBytes == null) {
      contentLength = -1; // sentinel: at least one part's size is unknown
    } else if (contentLength >= 0) {
      contentLength +=
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.fieldName}"; filename="${part.value.filename}"\r\n` +
            `Content-Type: ${part.value.contentType}\r\n\r\n`,
        ).byteLength +
        part.value.sizeBytes +
        encoder.encode("\r\n").byteLength;
    }
  }
  if (contentLength >= 0) contentLength += encoder.encode(`--${boundary}--\r\n`).byteLength;

  async function* generate(): AsyncGenerator<Uint8Array> {
    for (const part of parts) {
      if (typeof part.value === "string") {
        yield encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.fieldName}"\r\n\r\n${part.value}\r\n`,
        );
        continue;
      }
      yield encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.fieldName}"; filename="${part.value.filename}"\r\n` +
          `Content-Type: ${part.value.contentType}\r\n\r\n`,
      );
      // Readable.fromWeb makes the source stream a real Node async iterable,
      // yielding chunks as they arrive rather than waiting for the whole
      // thing -- this is the actual streaming step.
      const nodeStream = Readable.fromWeb(part.value.data as import("node:stream/web").ReadableStream<Uint8Array>);
      for await (const chunk of nodeStream) {
        yield chunk as Uint8Array;
      }
      yield encoder.encode("\r\n");
    }
    yield encoder.encode(`--${boundary}--\r\n`);
  }

  const webStream = Readable.toWeb(Readable.from(generate())) as unknown as ReadableStream<Uint8Array>;
  return {
    body: webStream,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: contentLength >= 0 ? contentLength : null,
  };
}
