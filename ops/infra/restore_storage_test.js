// Real restore drill for the weekly post-media Storage backup
// (backup_storage.js) -- the counterpart to the 2026-08-26 database restore
// drill recorded in SECURITY_CHECKLIST.md. That drill proved the database
// backup restores cleanly into a scratch project; this proves the same for
// the Storage backup, which had never actually been tested end to end --
// only that the download-to-local-disk step succeeds, never that the local
// files can be restored back into Supabase Storage intact.
//
// Never touches the real `post-media` bucket. Creates a throwaway bucket,
// uploads every file from the most recent local snapshot into it, downloads
// each one back and compares a SHA-256 checksum against the original local
// file, then deletes the throwaway bucket -- so nothing lingers as clutter
// or cost afterward, same discipline as the DB drill deleting its scratch
// project.
//
// Uploads/downloads run SEQUENTIALLY, not concurrently -- deliberate,
// following the exact lesson from today's Supabase-522-under-concurrency
// investigation (ops/health/health_ops.js) rather than risking the same
// failure mode here.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getSupabaseCredentials } = require("../config/credentials.js");

const BACKUP_ROOT = path.join(__dirname, "..", "..", "backups", "storage");
const TEST_BUCKET = `post-media-restore-test-${new Date().toISOString().slice(0, 10)}`;

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function latestSnapshotDir() {
  const snapshots = fs
    .readdirSync(BACKUP_ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (snapshots.length === 0) throw new Error("No local backup snapshots found under " + BACKUP_ROOT);
  return path.join(BACKUP_ROOT, snapshots[snapshots.length - 1]);
}

// Reverses backup_storage.js's `filePath.replace(/\//g, "__")`. Most real
// upload paths are accountId/filename (one level, per backup_storage.js's
// own comment), so splitting on the FIRST "__" reconstructs those. But a
// real 2026-09-22 drill found a genuine exception: at least one file
// (pinterest-demo-1785844820.mp4) lives at the bucket ROOT, with no account
// folder -- backup_storage.js's replace() is a no-op for a path with no "/",
// so its local name IS the original path, unchanged. No "__" in the local
// name means exactly that case.
function localNameToOriginalPath(localName) {
  const idx = localName.indexOf("__");
  if (idx === -1) return localName;
  return localName.slice(0, idx) + "/" + localName.slice(idx + 2);
}

async function createTestBucket(supabaseUrl, headers) {
  const res = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ id: TEST_BUCKET, name: TEST_BUCKET, public: true }),
  });
  if (!res.ok) throw new Error(`Failed to create test bucket: HTTP ${res.status} ${await res.text()}`);
}

// Real finding from the smoke test: the bucket-level `/empty` endpoint is
// ASYNC ("Empty bucket has been queued. Completion may take up to an hour"),
// so calling DELETE on the bucket immediately after races against it and
// can fail even though the bucket really is (about to be) empty. Deleting
// every object explicitly first, via the synchronous object-removal
// endpoint, avoids the race entirely -- we already know every path we
// uploaded, no need to ask Storage to figure it out asynchronously.
async function deleteTestBucket(supabaseUrl, headers, uploadedPaths) {
  if (uploadedPaths.length > 0) {
    const res = await fetch(`${supabaseUrl}/storage/v1/object/${TEST_BUCKET}`, {
      method: "DELETE",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: uploadedPaths }),
    });
    if (!res.ok) {
      console.error(`[restore-drill] object removal failed: HTTP ${res.status} ${await res.text()}`);
    }
  }
  const res = await fetch(`${supabaseUrl}/storage/v1/bucket/${TEST_BUCKET}`, { method: "DELETE", headers });
  return res.ok;
}

async function uploadFile(supabaseUrl, headers, originalPath, buf) {
  const res = await fetch(`${supabaseUrl}/storage/v1/object/${TEST_BUCKET}/${originalPath}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status} ${await res.text()}`);
}

async function downloadFile(supabaseUrl, headers, originalPath) {
  const res = await fetch(`${supabaseUrl}/storage/v1/object/${TEST_BUCKET}/${originalPath}`, { headers });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function runRestoreDrill() {
  const creds = getSupabaseCredentials();
  const headers = { Authorization: `Bearer ${creds.serviceRoleKey}`, apikey: creds.serviceRoleKey };

  const snapshotDir = latestSnapshotDir();
  const localFiles = fs.readdirSync(snapshotDir);

  const result = {
    snapshotUsed: path.basename(snapshotDir),
    testBucket: TEST_BUCKET,
    totalLocalFiles: localFiles.length,
    restored: 0,
    verifiedByteForByte: 0,
    failures: [],
    bucketCleanedUp: false,
  };

  console.log(`[restore-drill] Creating throwaway bucket ${TEST_BUCKET}...`);
  await createTestBucket(creds.url, headers);

  const uploadedPaths = [];
  try {
    for (let i = 0; i < localFiles.length; i++) {
      const localName = localFiles[i];
      if (i > 0 && i % 100 === 0) {
        console.log(`[restore-drill] progress: ${i}/${localFiles.length}, ${result.verifiedByteForByte} verified, ${result.failures.length} failures so far`);
      }
      try {
        const originalPath = localNameToOriginalPath(localName);
        const localBuf = fs.readFileSync(path.join(snapshotDir, localName));
        const localHash = sha256(localBuf);

        await uploadFile(creds.url, headers, originalPath, localBuf);
        result.restored++;
        uploadedPaths.push(originalPath);

        const restoredBuf = await downloadFile(creds.url, headers, originalPath);
        const restoredHash = sha256(restoredBuf);

        if (restoredHash === localHash && restoredBuf.length === localBuf.length) {
          result.verifiedByteForByte++;
        } else {
          result.failures.push({ file: originalPath, reason: "checksum/length mismatch after restore" });
        }
      } catch (err) {
        // originalPath may not exist yet if localNameToOriginalPath itself
        // threw -- localName always does, so use that as the failure key.
        result.failures.push({ file: localName, reason: err.message });
      }
    }
  } finally {
    console.log(`[restore-drill] Cleaning up throwaway bucket ${TEST_BUCKET} (${uploadedPaths.length} objects)...`);
    result.bucketCleanedUp = await deleteTestBucket(creds.url, headers, uploadedPaths);
  }

  return result;
}

module.exports = { runRestoreDrill };

if (require.main === module) {
  runRestoreDrill()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
