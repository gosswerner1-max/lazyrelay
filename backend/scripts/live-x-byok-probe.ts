// Live probe for the X bring-your-own-key code, to be run BY HAND with a funded test X app. NOT part of the vitest suite.
//
//   npx tsx scripts/live-x-byok-probe.ts <path-to-keys.json> [--post]
//
// keys.json holds { "apiKey": "...", "apiSecret": "...", "accessToken": "...", "accessTokenSecret": "..." } (the four
// OAuth 1.0a values of an X developer app with Read and Write permission). The file is read once, never copied, and no
// key value is ever printed: only a masked suffix of the API key.
//
// Steps, each printed as PASS or FAIL with the HTTP status and X's own error title / type / detail (never a request
// header):
//   1. signed GET /2/users/me                       -> handle and id
//   2. v2 media upload of a 1x1 PNG                 -> initialize, append, finalize (and status if X asks)
//   3. v1.1 media upload of the same PNG            -> INIT, APPEND, FINALIZE (and STATUS if X asks)
//   4. only with --post: one post "LazyRelay BYOK probe" (with the media id of whichever flow worked), then DELETE it
//
// Cost: with --post it is one plain post (about $0.015) plus a few reads and the media calls: a few cents.
//
// If the keys file is missing, unreadable, not JSON or lacks any of the four values, the script prints ONE line starting
// with SKIPPED, makes no network request and exits 0. It exits non-zero only for a real unexpected bug after the keys were
// loaded. Media upload is UNVERIFIED against live X with OAuth 1.0a until this has been run.

import { readFile as fsReadFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createXSignedFetch, readJson, readXError, scrubSecrets, X_API_BASE } from "../src/platforms/xApi.js";
import { bundleSecrets, xKeyHint, type XByokBundle } from "../src/platforms/xByok.js";
import { createXMediaUploader, type XMediaFlow, type XMediaResult } from "../src/platforms/xMedia.js";

export interface ProbeDeps {
  readFile: (path: string) => Promise<string>;
  fetchImpl: typeof fetch;
  log: (line: string) => void;
}

const defaultDeps = (): ProbeDeps => ({
  readFile: (p) => fsReadFile(p, "utf8"),
  fetchImpl: (...a) => fetch(...a),
  log: (line) => console.log(line),
});

/** A valid 1x1 transparent PNG (67 bytes). */
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const FIELDS = ["apiKey", "apiSecret", "accessToken", "accessTokenSecret"] as const;

type Loaded = { ok: true; bundle: XByokBundle } | { ok: false; reason: string };

/** Reads and checks the keys file. Never throws and never puts file content in the reason. */
export async function loadKeys(path: string | undefined, deps: Pick<ProbeDeps, "readFile">): Promise<Loaded> {
  if (!path || !path.trim()) return { ok: false, reason: "no X keys file (pass a JSON path)" };
  let text: string;
  try {
    text = await deps.readFile(path);
  } catch {
    return { ok: false, reason: `X keys file not found or unreadable (${basename(path)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: `X keys file is not valid JSON (${basename(path)})` };
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const missing = FIELDS.filter((f) => typeof obj[f] !== "string" || (obj[f] as string).trim() === "");
  if (missing.length > 0) return { ok: false, reason: `X keys file is missing: ${missing.join(", ")}` };
  const v = (f: (typeof FIELDS)[number]) => (obj[f] as string).trim();
  return { ok: true, bundle: { apiKey: v("apiKey"), apiSecret: v("apiSecret"), accessToken: v("accessToken"), accessTokenSecret: v("accessTokenSecret") } };
}

/** Runs the probe and returns the process exit code. Never throws. */
export async function runProbe(argv: string[], partial: Partial<ProbeDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...partial };
  let secrets: string[] = [];
  const say = (line: string) => deps.log(scrubSecrets(line, secrets));
  try {
    const wantsPost = argv.includes("--post");
    const path = argv.find((a) => !a.startsWith("--"));
    const loaded = await loadKeys(path, deps);
    if (!loaded.ok) {
      deps.log(`SKIPPED: ${loaded.reason}. No network request was made.`);
      return 0;
    }
    const bundle = loaded.bundle;
    secrets = bundleSecrets(bundle);
    const signed = createXSignedFetch(bundle, deps.fetchImpl);
    say(`X BYOK live probe. API key ${xKeyHint(bundle.apiKey)}. ${wantsPost ? "Will post and delete one test post." : "No post (add --post to create and delete one)."}`);

    const errorLine = async (res: Response) => {
      const e = readXError(await readJson(res));
      return `status ${res.status}${e.title ? `, title: ${e.title}` : ""}${e.type ? `, type: ${e.type}` : ""}${e.detail ? `, detail: ${e.detail}` : ""}`;
    };
    const explain = (status: number | null): string =>
      status === 402 || status === 403 || status === 429 ? " (a credits, spending-limit, permission or rate-limit answer from X, not a code fault)" : "";

    // 1. who am I
    let handle: string | null = null;
    try {
      const res = await signed({ method: "GET", url: `${X_API_BASE}/2/users/me` });
      const body = (await readJson(res)) as { data?: { id?: string; username?: string } } | null;
      if (res.ok && body?.data?.username) {
        handle = body.data.username;
        say(`1. PASS  GET /2/users/me  status ${res.status}  @${body.data.username} (id ${body.data.id ?? "?"})`);
      } else {
        say(`1. FAIL  GET /2/users/me  ${scrubSecrets(await errorLine(res), secrets)}${explain(res.status)}`);
      }
    } catch {
      say("1. FAIL  GET /2/users/me  could not reach X");
    }

    // 2 and 3. media, both flows
    const mediaIds: Partial<Record<XMediaFlow, string>> = {};
    const flows: Array<[string, XMediaFlow]> = [["2", "v2"], ["3", "v1.1"]];
    for (const [n, flow] of flows) {
      let result: XMediaResult;
      try {
        result = await createXMediaUploader(flow, bundle, { fetchImpl: deps.fetchImpl }).upload({ bytes: TINY_PNG, mimeType: "image/png" });
      } catch {
        say(`${n}. FAIL  media upload (${flow})  unexpected error before any answer from X`);
        continue;
      }
      for (const s of result.steps) {
        say(`${n}.     ${s.ok ? "PASS" : "FAIL"}  ${flow} ${s.step}  status ${s.status ?? "none"}${s.error ? `  title: ${s.error.title ?? "-"}  type: ${s.error.type ?? "-"}  detail: ${s.error.detail ?? "-"}` : ""}${s.ok ? "" : explain(s.status)}`);
      }
      if (result.ok) {
        mediaIds[flow] = result.mediaId;
        say(`${n}. PASS  media upload (${flow}) accepted, media id ${result.mediaId}`);
      } else {
        say(`${n}. FAIL  media upload (${flow}) stopped at the "${result.failedStep}" step`);
      }
    }
    say(`Media verdict: v2 ${mediaIds.v2 ? "WORKS" : "did not work"}, v1.1 ${mediaIds["v1.1"] ? "WORKS" : "did not work"}. Set X_MEDIA_UPLOAD_CONFIG.flow in src/platforms/xMedia.ts to a flow that works.`);

    // 4. post and delete
    if (!wantsPost) {
      say("4. SKIPPED  no --post flag, no post was created");
    } else {
      const mediaId = mediaIds.v2 ?? mediaIds["v1.1"];
      let postId: string | null = null;
      try {
        const res = await signed({
          method: "POST",
          url: `${X_API_BASE}/2/tweets`,
          json: { text: "LazyRelay BYOK probe", ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) },
        });
        const body = (await readJson(res)) as { data?: { id?: string } } | null;
        if (res.ok && body?.data?.id) {
          postId = body.data.id;
          say(`4. PASS  POST /2/tweets  status ${res.status}  post id ${postId}${mediaId ? " (with media)" : " (text only, no media flow worked)"}`);
        } else {
          say(`4. FAIL  POST /2/tweets  ${scrubSecrets(await errorLine(res), secrets)}${explain(res.status)}`);
        }
      } catch {
        say("4. FAIL  POST /2/tweets  could not reach X");
      }
      if (postId) {
        try {
          const del = await signed({ method: "DELETE", url: `${X_API_BASE}/2/tweets/${encodeURIComponent(postId)}` });
          const body = (await readJson(del)) as { data?: { deleted?: boolean } } | null;
          say(del.ok && body?.data?.deleted ? `4. PASS  DELETE /2/tweets/${postId}  status ${del.status}  deleted` : `4. FAIL  DELETE /2/tweets/${postId}  ${scrubSecrets(await errorLine(del), secrets)}  (delete it by hand on @${handle ?? "your account"})`);
        } catch {
          say(`4. FAIL  DELETE /2/tweets/${postId}  could not reach X  (delete it by hand on @${handle ?? "your account"})`);
        }
      }
    }
    return 0;
  } catch (err) {
    // Reached only for a real bug. Whatever happened, no key value leaves this function.
    const message = err instanceof Error ? err.message : "unknown error";
    deps.log(`FAILED: unexpected error in the probe: ${scrubSecrets(message, secrets).slice(0, 200)}`);
    return secrets.length > 0 ? 1 : 0; // a problem before any key was loaded is a config problem, not a bug
  }
}

const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntryPoint) {
  runProbe(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      console.log("SKIPPED: the probe could not start. No network request was made.");
      process.exit(0);
    },
  );
}
