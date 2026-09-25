// media routes — extracted verbatim from the original single buildRouter()
// in http/routes.ts (split 2026-09-25, pure mechanical move: same paths,
// same middleware order, same handler bodies). http/routes.ts mounts this.
// Follow-up the same day: hand-written request-body type/length checks
// replaced with zod schemas (see http/validation.ts) — same messages, same
// accept/reject rules, same order.

import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { imageSizeFromFile } from "image-size/fromFile";
import { fileTypeFromFile } from "file-type";
import { supabase } from "../../supabase.js";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { checkQuotaForNewUpload, getStorageUsage } from "../../storageQuota.js";
import { dbError } from "./shared.js";
import { validateBody } from "../validation.js";

// Post media (images/video attached to a scheduled post) — uploaded via
// multipart form data. Streamed to a temp file on disk as it arrives
// (multer.diskStorage), not buffered in process memory — the backend runs
// as a single Node process on a 512MB Render instance, so an in-memory
// buffer per upload (the original approach) meant two concurrent uploads
// near the cap could OOM-crash the whole server, not just fail the upload.
// The temp file is streamed on to Supabase Storage's "post-media" bucket
// (see migration 0007_post_media_bucket.sql) and deleted afterward either
// way (found 2026-09-04 while raising this from its original 20MB).
//
// Raised to 1GB 2026-09-05 (was 45MB). The old 45MB cap was tied to a stale
// assumption that this project was on Supabase's Free plan (50MB/object
// ceiling) -- it isn't; the org is actually on Pro (confirmed live via the
// Management API), which allows the bucket's fileSizeLimit up to 500GB and a
// single non-multipart upload up to 5GB. 1GB comfortably covers a real
// multi-minute customer video with wide margin (competitor benchmarking:
// Sprout Social 3GB, Vista Social 2GB, Hootsuite/Loomly 1GB flat caps -- this
// puts LazyRelay in the same band, not at the back of it). The Supabase
// Storage bucket's own fileSizeLimit was raised to match via the Management
// API the same day. Real protection against a platform's own lower ceiling
// (e.g. Telegram's hard 50MB) lives in mediaLimits.ts, not here.
const MEDIA_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const ALLOWED_MEDIA_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm", // TikTok-supported format, not previously allowed here
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) => cb(null, randomUUID()),
  }),
  limits: { fileSize: MEDIA_UPLOAD_MAX_BYTES },
});

export function buildMediaRouter(): Router {
  const router = Router();

  // Uploads a single image/video for use as a scheduled post's media_url.
  // Goes through our own service-role Supabase client, not the browser
  // directly — customers never touch storage credentials, and this is
  // where mime-type/size validation actually gets enforced server-side.
  // Alt text (2026-08-16) — an optional accessibility description attached
  // to the file itself, independent of which post(s) it ends up in.
  const MAX_ALT_TEXT_LENGTH = 1000; // matches Mastodon's own limit, the one adapter that consumes it today
  const ALT_TEXT_TOO_LONG = `altText must be ${MAX_ALT_TEXT_LENGTH} characters or fewer`;
  const mediaUploadBodySchema = z.object({
    altText: z.string({ error: "altText must be a string" }).max(MAX_ALT_TEXT_LENGTH, ALT_TEXT_TOO_LONG).optional(),
  });
  router.post("/media/upload", requireAuth, tieredRateLimit, upload.single("file"), async (req: AuthedRequest, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded (expected multipart field \"file\")" });
      return;
    }
    try {
      // multer puts non-file multipart fields onto req.body as strings.
      const body = validateBody(mediaUploadBodySchema, req.body);
      if (!body.ok) {
        res.status(400).json({ error: body.error });
        return;
      }
      const altTextInput = body.data.altText;
      const altText = altTextInput?.trim() || null;
      // The client-supplied mimetype/filename (file.mimetype, file.originalname)
      // are just headers the caller chose to send — trusting them is how a file
      // named "photo.png.exe" with a spoofed image/png Content-Type would sail
      // through and land in storage with a literal .exe extension. Detect the
      // REAL type from the file's magic bytes instead, and use that (not
      // anything client-supplied) for both the allowlist check and the stored
      // file's extension/content-type. Reads just the header, not the whole
      // file, same as everything else in this route now that it's disk-backed.
      const detected = await fileTypeFromFile(file.path);
      if (!detected || !ALLOWED_MEDIA_MIME_TYPES.has(detected.mime)) {
        res.status(400).json({
          error: `Unsupported or unrecognized file type${detected ? ` "${detected.mime}"` : ""} — use an image (jpeg/png/webp/gif) or video (mp4/mov/webm)`,
        });
        return;
      }

      // Per-account storage quota — the defense against the "upload media
      // forever, never attached to anything, for free" cost-abuse gap. We
      // never delete a customer's files ourselves; once they're at quota,
      // new uploads are rejected until they delete something or upgrade —
      // same model as any cloud storage gauge, not a notice-and-delete policy.
      const quotaError = await checkQuotaForNewUpload(req.accountId!, file.size);
      if (quotaError) {
        res.status(413).json({ error: quotaError });
        return;
      }

      // storage.objects and media_uploads both stay on supabase through this
      // whole route (and the rest of the media_uploads routes below) --
      // 0007_post_media_bucket.sql: "all writes go through the backend's
      // service-role client... no client-facing storage RLS policies are
      // needed," and 0009_media_uploads.sql: same fail-closed-by-omission
      // pattern, no anon/authenticated policies on media_uploads either.
      // req.db would get a permissions error on the storage write and zero
      // rows on the table.
      //
      // Streamed straight from the temp file rather than read into a buffer
      // first — storage-js's upload() accepts a Node ReadableStream directly,
      // so the file's bytes are never held in process memory at all, on
      // either side of this request.
      const path = `${req.accountId}/${randomUUID()}.${detected.ext}`;
      const { error: uploadError } = await supabase.storage
        .from("post-media")
        .upload(path, fs.createReadStream(file.path), { contentType: detected.mime });
      if (uploadError) {
        dbError(res, uploadError, "POST /media/upload storage.upload");
        return;
      }

      const { data } = supabase.storage.from("post-media").getPublicUrl(path);

      // Measure real dimensions ourselves (images only — video needs ffprobe,
      // not added yet, see mediaLimits.ts) so /scheduled-posts can validate
      // against the TARGET platform's actual requirements later using
      // server-measured metadata, not anything a client could misreport.
      // image-size's fromFile entry point reads a file path directly (just
      // enough of the header, not the whole file) — no need to load it
      // ourselves. image-size 2.x dropped the old sync file-path API in
      // favor of this async one (main `imageSize` export now takes only a
      // Uint8Array — see the image-size 1→2 Dependabot bump for the diff).
      // image-size's ICNS/JXL/HEIF parsers carry an unpatched infinite-loop
      // DoS, but those mime types are already rejected by
      // ALLOWED_MEDIA_MIME_TYPES above, long before detected.mime can ever
      // reach here — see the 2026-08-11 Dependabot dismissal on this exact
      // CVE for the record.
      let width: number | null = null;
      let height: number | null = null;
      if (detected.mime.startsWith("image/")) {
        try {
          const dims = await imageSizeFromFile(file.path);
          width = dims.width ?? null;
          height = dims.height ?? null;
        } catch {
          // Unreadable/corrupt image headers — leave dimensions null rather
          // than fail the upload; the platform itself will reject it later
          // if it's genuinely broken, and dimension checks just get skipped.
        }
      }

      const { data: mediaRow, error: metaError } = await supabase
        .from("media_uploads")
        .insert({
          account_id: req.accountId,
          url: data.publicUrl,
          storage_path: path,
          mime_type: detected.mime,
          size_bytes: file.size,
          width,
          height,
          alt_text: altText,
        })
        .select("id, url, alt_text")
        .single();
      if (metaError) {
        dbError(res, metaError, "POST /media/upload media_uploads.insert");
        return;
      }

      // id included alongside the historical `url`-only shape so a caller can
      // later PATCH /media/:id to add/edit alt text without a separate lookup.
      res.status(201).json({ id: mediaRow.id, url: mediaRow.url, altText: mediaRow.alt_text });
    } finally {
      // Always clean up the temp file — success, validation failure, or a
      // thrown error. Best-effort: a delete failure here shouldn't mask
      // whatever response was already sent, just leaves one stray file for
      // the OS to reclaim on its own temp-dir schedule.
      fs.promises.unlink(file.path).catch(() => {});
    }
  });

  // Edits a media item's alt text after upload (2026-08-16) — the one field
  // on media_uploads a customer can revise later; everything else about an
  // uploaded file is immutable (re-upload to change the file itself).
  const mediaEditBodySchema = z.object({
    altText: z.string({ error: "altText must be a string or null" }).max(MAX_ALT_TEXT_LENGTH, ALT_TEXT_TOO_LONG).nullish(),
  });
  router.patch("/media/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const body = validateBody(mediaEditBodySchema, req.body);
    if (!body.ok) {
      res.status(400).json({ error: body.error });
      return;
    }
    const altTextInput = body.data.altText;
    // media_uploads: service-role only, see the comment on POST
    // /media/upload above (0009_media_uploads.sql).
    const { data: updated, error } = await supabase
      .from("media_uploads")
      .update({ alt_text: altTextInput?.trim() || null })
      .eq("id", req.params.id)
      .eq("account_id", req.accountId)
      .select("id, url, alt_text")
      .maybeSingle();
    if (error) {
      dbError(res, error, "PATCH /media/:id");
      return;
    }
    if (!updated) {
      res.status(404).json({ error: "Not found or not owned by this caller" });
      return;
    }
    res.json({ id: updated.id, url: updated.url, altText: updated.alt_text });
  });

  // Storage gauge — used/quota bytes for the caller's account, same model
  // as any cloud-storage usage indicator. See storageQuota.ts.
  router.get("/media/usage", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    try {
      const usage = await getStorageUsage(req.accountId!);
      res.json(usage);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Lists the caller's own uploaded media, newest first — the "manage your
  // files" view a customer uses to find something to delete once they're
  // near quota. Each file also carries `platforms`: which platform(s) it's
  // actually been posted to, so the frontend can group storage by platform
  // (2026-08-20). A file isn't tied to a platform at upload time and the
  // same file can be posted to several platforms at once, so this is a
  // many-to-many map, not a single owner — built from the account's FULL
  // post history (not just the recent slice /scheduled-posts keeps in
  // memory for the dashboard) so the breakdown stays accurate for accounts
  // with a long posting history.
  router.get("/media", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    const [
      { data: media, error },
      { data: postRows, error: postsError },
      { data: scheduleRows, error: scheduleError },
    ] = await Promise.all([
      // media_uploads: service-role only, see the comment on POST
      // /media/upload above (0009_media_uploads.sql).
      supabase
        .from("media_uploads")
        .select("id, url, mime_type, size_bytes, width, height, alt_text, created_at")
        .eq("account_id", req.accountId)
        .order("created_at", { ascending: false }),
      req.db!
        .from("scheduled_posts")
        .select("media_url, social_accounts(platform)")
        .eq("account_id", req.accountId)
        .not("media_url", "is", null),
      req.db!
        .from("recurring_schedule_targets")
        .select("social_accounts(platform), recurring_schedules!inner(media_url, account_id)")
        .eq("recurring_schedules.account_id", req.accountId),
    ]);
    if (error) {
      dbError(res, error, "GET /media");
      return;
    }
    if (postsError) {
      dbError(res, postsError, "GET /media scheduled_posts lookup");
      return;
    }
    if (scheduleError) {
      dbError(res, scheduleError, "GET /media recurring_schedule_targets lookup");
      return;
    }

    // Supabase's embed comes back as an object or a single-element array
    // depending on how it infers the relationship's cardinality — normalize
    // both shapes rather than assuming one (same defensive pattern used for
    // social_accounts(platform) elsewhere in this file).
    function embedOne<T>(x: T | T[] | null | undefined): T | null {
      return Array.isArray(x) ? (x[0] ?? null) : (x ?? null);
    }

    const platformsByUrl = new Map<string, Set<string>>();
    function addUsage(url: string | null | undefined, platform: string | null | undefined) {
      if (!url || !platform) return;
      const set = platformsByUrl.get(url) ?? new Set<string>();
      set.add(platform);
      platformsByUrl.set(url, set);
    }
    for (const row of postRows ?? []) {
      addUsage(row.media_url, embedOne(row.social_accounts as { platform: string } | { platform: string }[] | null)?.platform);
    }
    for (const row of scheduleRows ?? []) {
      const schedule = embedOne(row.recurring_schedules as { media_url: string | null } | { media_url: string | null }[] | null);
      addUsage(schedule?.media_url, embedOne(row.social_accounts as { platform: string } | { platform: string }[] | null)?.platform);
    }

    res.json(
      (media ?? []).map((m) => ({
        ...m,
        platforms: [...(platformsByUrl.get(m.url) ?? new Set<string>())].sort(),
      })),
    );
  });

  // Deletes a customer's own uploaded media — this is the ONLY way media
  // ever gets removed; LazyRelay never auto-deletes a customer's files.
  // Blocked if the file is still referenced by a pending/posting scheduled
  // post (checked via media_url match) so deleting storage out from under
  // an about-to-fire post can't silently break it.
  router.delete("/media/:id", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    // media_uploads/storage.objects: service-role only, see the comment on
    // POST /media/upload above (0007_post_media_bucket.sql /
    // 0009_media_uploads.sql).
    const { data: media, error: mediaError } = await supabase
      .from("media_uploads")
      .select("id, account_id, url, storage_path")
      .eq("id", req.params.id)
      .single();
    if (mediaError || !media || media.account_id !== req.accountId) {
      res.status(404).json({ error: "Media not found or not owned by this caller" });
      return;
    }

    const { count: inUseCount, error: inUseError } = await req.db!
      .from("scheduled_posts")
      .select("id", { count: "exact", head: true })
      .eq("media_url", media.url)
      .in("status", ["pending", "posting"]);
    if (inUseError) {
      dbError(res, inUseError, "DELETE /media/:id scheduled_posts lookup");
      return;
    }
    if ((inUseCount ?? 0) > 0) {
      res.status(409).json({ error: "This file is attached to a post that hasn't gone out yet — cancel or wait for that post before deleting it." });
      return;
    }

    if (media.storage_path) {
      const { error: storageError } = await supabase.storage.from("post-media").remove([media.storage_path]);
      if (storageError) {
        dbError(res, storageError, "DELETE /media/:id storage.remove");
        return;
      }
    }

    const { error: deleteError } = await supabase.from("media_uploads").delete().eq("id", media.id);
    if (deleteError) {
      dbError(res, deleteError, "DELETE /media/:id media_uploads.delete");
      return;
    }

    res.status(204).send();
  });

  return router;
}
