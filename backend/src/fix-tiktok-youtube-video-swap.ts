import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// One-off fix (2026-09-04): the launch ad batch (schedule-launch-ad-batch.ts)
// scheduled plain JPEG images to every platform, including TikTok and
// YouTube -- both video-only through this integration (confirmed in
// platforms/tiktok.ts and platforms/youtube.ts). Every post to those two
// platforms was guaranteed to fail identically. Werner: "we can fix this" --
// swaps every pending TikTok/YouTube post's media to one of the 3 real
// promotional videos already built for these platforms (cycled), and
// replaces the 2 already-failed posts with fresh ones using the same
// pattern.

const BACKEND_URL = "https://lazyrelaylazyrelay-backend.onrender.com/api";
const TOKEN = fs.readFileSync("C:\\Users\\werne\\AppData\\Local\\Temp\\lr_dogfood_token.txt", "utf-8").trim();
const IMAGE_ROOT = "C:\\Users\\werne\\Claude\\LazyRelay-social-posts\\by-platform";

const CAPTIONS = [
  "Simplify your life with LazyRelay: schedule once, post everywhere, with real Proof-of-Publish verification.",
  "Real talk: scheduling posts across 13+ platforms should not mean logging into 13+ dashboards. LazyRelay handles it from one place, with Proof-of-Publish confirming every post actually went live.",
  "Schedule once, publish everywhere. LazyRelay verifies every post actually went live, not just accepted.",
  "LazyRelay update: schedule your content once and publish it across every platform your business runs on, with real Proof-of-Publish verification confirming it actually went live.",
  "New from LazyRelay: schedule a post once, publish it everywhere, and know for certain it went live with real Proof-of-Publish verification.",
  "Simplify your social media: schedule your posts once with LazyRelay and publish everywhere, with real Proof-of-Publish verification confirming they actually went live.",
  "LazyRelay: schedule once, publish everywhere. Real Proof-of-Publish verification confirms every post actually went live.",
  "Schedule once. Publish everywhere. LazyRelay.",
  "Schedule once. Publish everywhere. LazyRelay confirms every post actually went live with real Proof-of-Publish verification.",
];

const TARGETS = [
  { platform: "tiktok", socialAccountId: "ed7f34ba-f675-4b6c-9ab7-9f380ba16be6" },
  { platform: "youtube", socialAccountId: "d7ea6c35-24ff-4cce-9e79-a4070bc62b09" },
];

async function uploadVideo(platform: string, filePath: string): Promise<string> {
  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: "video/mp4" }), path.basename(filePath));
  const res = await fetch(`${BACKEND_URL}/media/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  const json = (await res.json()) as { url?: string; error?: string };
  if (!res.ok || !json.url) throw new Error(json.error ?? `upload failed HTTP ${res.status}`);
  return json.url;
}

async function patchMedia(id: string, mediaUrl: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/scheduled-posts/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mediaUrl }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `patch failed HTTP ${res.status}`);
  }
}

async function deletePost(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/scheduled-posts/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete failed HTTP ${res.status}`);
  }
}

async function schedulePost(socialAccountId: string, content: string, mediaUrl: string, scheduledFor: string): Promise<string> {
  const res = await fetch(`${BACKEND_URL}/scheduled-posts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ socialAccountId, content, mediaUrl, scheduledFor }),
  });
  const json = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || !json.id) throw new Error(json.error ?? `schedule failed HTTP ${res.status}`);
  return json.id;
}

interface ScheduledPostRow {
  id: string;
  content: string;
  status: string;
  scheduled_for: string;
}

async function listPosts(socialAccountId: string): Promise<ScheduledPostRow[]> {
  const res = await fetch(`${BACKEND_URL}/scheduled-posts`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const all = (await res.json()) as (ScheduledPostRow & { social_account_id: string })[];
  return all.filter((p) => p.social_account_id === socialAccountId);
}

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  for (const target of TARGETS) {
    console.log(`\n=== ${target.platform} ===`);
    const dir = path.join(IMAGE_ROOT, target.platform);
    const videoFiles = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".mp4"))
      .sort();
    console.log(`Uploading ${videoFiles.length} real videos...`);
    const videoUrls = await runWithConcurrency(videoFiles, 3, (f) => uploadVideo(target.platform, path.join(dir, f)));
    console.log("Videos uploaded:", videoUrls);

    const posts = await listPosts(target.socialAccountId);
    const pending = posts.filter((p) => p.status === "pending");
    const failed = posts.filter((p) => p.status === "failed");
    console.log(`Found ${pending.length} pending, ${failed.length} failed`);

    // Fix the pending ones in place -- keeps their original scheduled_for.
    let fixed = 0;
    await runWithConcurrency(pending, 6, async (post, i) => {
      await patchMedia(post.id, videoUrls[i % videoUrls.length]);
      fixed++;
      if (fixed % 20 === 0) console.log(`  ${fixed}/${pending.length} fixed`);
    });
    console.log(`${fixed}/${pending.length} pending posts fixed`);

    // Failed ones can't be PATCHed (only draft/pending) -- delete and
    // reschedule fresh, a few minutes out.
    let replaced = 0;
    for (const post of failed) {
      await deletePost(post.id);
      const scheduledFor = new Date(Date.now() + (replaced + 1) * 5 * 60 * 1000).toISOString();
      const content = CAPTIONS[replaced % CAPTIONS.length];
      await schedulePost(target.socialAccountId, content, videoUrls[replaced % videoUrls.length], scheduledFor);
      replaced++;
    }
    console.log(`${replaced}/${failed.length} failed posts replaced with fresh video posts`);
  }
  console.log("\nDONE.");
}

main().catch((err) => {
  console.error("Fix failed:", err);
  process.exit(1);
});
