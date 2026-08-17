// Weekly backup of the post-media Supabase Storage bucket — closes the one
// gap the 2026-07-31 provider-security sweep flagged and left open: only
// the database gets backed up (Supabase's own daily snapshots), uploaded
// customer media had zero backup coverage at all.
//
// Deliberately simple for now: volume is tiny (42MB / 28 files as of
// 2026-08-17, zero real paying customers), so this downloads the whole
// bucket to a local dated folder rather than standing up a second cloud
// destination — no new service, no new recurring cost. Revisit with a real
// off-machine destination (S3/Backblaze) once real customer volume exists;
// a local-only backup is a hedge against Supabase-side data loss, not
// against this machine dying, which is a known, accepted limitation of
// this first pass.
//
// Keeps the last 4 weekly snapshots and prunes older ones so this can't
// grow unbounded.

const fs = require("fs");
const path = require("path");
const { getSupabaseCredentials } = require("../config/credentials.js");

const BUCKET = "post-media";
const BACKUP_ROOT = path.join(__dirname, "..", "..", "backups", "storage");
const KEEP_SNAPSHOTS = 4;

async function listAllFiles(supabaseUrl, serviceKey) {
  const headers = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
  const topRes = await fetch(`${supabaseUrl}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 1000, prefix: "" }),
  });
  const top = await topRes.json();

  const files = [];
  for (const entry of top) {
    if (entry.id === null) {
      // Folder — one level deep is enough, every upload path in this repo
      // is accountId/filename, never nested further.
      const subRes = await fetch(`${supabaseUrl}/storage/v1/object/list/${BUCKET}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 1000, prefix: `${entry.name}/` }),
      });
      const sub = await subRes.json();
      for (const f of sub) {
        if (f.id !== null) files.push(`${entry.name}/${f.name}`);
      }
    } else {
      files.push(entry.name);
    }
  }
  return files;
}

function pruneOldSnapshots() {
  if (!fs.existsSync(BACKUP_ROOT)) return;
  const snapshots = fs
    .readdirSync(BACKUP_ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const toRemove = snapshots.slice(0, Math.max(0, snapshots.length - KEEP_SNAPSHOTS));
  for (const dir of toRemove) {
    fs.rmSync(path.join(BACKUP_ROOT, dir), { recursive: true, force: true });
  }
  return toRemove;
}

async function backupStorage() {
  const creds = getSupabaseCredentials(); // throws if unset -- see credentials.js

  const dateStr = new Date().toISOString().slice(0, 10);
  const snapshotDir = path.join(BACKUP_ROOT, dateStr);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const files = await listAllFiles(creds.url, creds.serviceRoleKey);
  let downloaded = 0;
  let failed = 0;
  for (const filePath of files) {
    try {
      const res = await fetch(`${creds.url}/storage/v1/object/${BUCKET}/${filePath}`, {
        headers: { Authorization: `Bearer ${creds.serviceRoleKey}`, apikey: creds.serviceRoleKey },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const dest = path.join(snapshotDir, filePath.replace(/\//g, "__"));
      fs.writeFileSync(dest, buf);
      downloaded++;
    } catch (err) {
      failed++;
      console.error(`[backup_storage] failed to download ${filePath}:`, err.message);
    }
  }

  const pruned = pruneOldSnapshots();

  return { ok: true, snapshotDir, totalFiles: files.length, downloaded, failed, prunedSnapshots: pruned };
}

module.exports = { backupStorage };

if (require.main === module) {
  backupStorage()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
