import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// One-off operational script (2026-09-04): loads the full 84-image ad pool
// built earlier for LazyRelay's own launch, and schedules it across every
// real connected social account on the dogfooding account, at 6 posts/day
// per account (every 4 hours) -- exhausts the 84-image pool over 14 days
// per account. Werner's explicit go-ahead, including the two off-brand/
// test-labeled accounts ("post on them, it's fine, will sort this out
// later"). Captions are the 9 real, already-live homepage marquee lines
// (Landing.tsx PROOF_POSTS) -- proven, accurate, nothing new to write.

const BACKEND_URL = "https://lazyrelaylazyrelay-backend.onrender.com/api";
const TOKEN = fs.readFileSync("C:\\Users\\werne\\AppData\\Local\\Temp\\lr_dogfood_token.txt", "utf-8").trim();
const IMAGE_ROOT = "C:\\Users\\werne\\Claude\\LazyRelay-social-posts\\by-platform";
const RESULTS_FILE = path.join(import.meta.dirname, "..", "..", "schedule-launch-ad-batch-results.json");

const POSTS_PER_DAY = 6;
const HOURS_BETWEEN = 24 / POSTS_PER_DAY; // 4
const START_DELAY_MS = 60 * 60 * 1000; // first post 1 hour from now

// The 9 real, already-live captions from frontend/src/pages/Landing.tsx's
// PROOF_POSTS array -- proven, accurate, no new copy invented for this.
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

// Real connected accounts, pulled live via GET /social-accounts 2026-09-04.
// Werner confirmed posting to all of them, including the two off-brand/
// test-labeled ones -- his call, sorting the mislabeling out later.
const ACCOUNTS: { id: string; platform: string; label: string }[] = [
  { id: "7bd2c6bf-c8eb-4827-8664-aecd5e26d3bc", platform: "linkedin", label: "Luzaan Jacobs" },
  { id: "5c9ccb56-83bb-4280-92b7-fcb78532e716", platform: "pinterest", label: "lazydownload" },
  { id: "788fdbd2-d7fa-4a88-8dfd-73d5e028103a", platform: "mastodon", label: "lazyrelay" },
  { id: "98dd861b-b1cd-43b4-a627-5f6f2a748c2b", platform: "bluesky", label: "lazyrelay.bsky.social" },
  { id: "43458426-cb53-4876-aeb0-44a15be82573", platform: "facebook", label: "LazyRelay" },
  { id: "4f5e16a6-8cd3-449b-a797-c47ce2c84822", platform: "instagram", label: "lazyrelay" },
  { id: "5d551c06-ce76-4d49-bc32-ef39fe0a11c9", platform: "telegram", label: "LazyRelay Test Channel" },
  { id: "ed7f34ba-f675-4b6c-9ab7-9f380ba16be6", platform: "tiktok", label: "LazyRelay" },
  { id: "6d97a56b-a956-4b15-8fe2-1a3f955d8842", platform: "pinterest", label: "004tyo6cu3j89vudkqnsxmmp44ybkc" },
  { id: "a23c2f90-89b1-4c6e-8841-488904d7793c", platform: "discord", label: "LazyRelay" },
  { id: "51ed884c-0f22-4c66-b5dc-a4b5f1850466", platform: "threads", label: "thelazydownload" },
  { id: "ba8ee954-0f4d-47b3-a3f3-79cbab0f4afa", platform: "facebook", label: "LazyRelay Test Page 2" },
  { id: "d7ea6c35-24ff-4cce-9e79-a4070bc62b09", platform: "youtube", label: "LazyRelay" },
  { id: "bffef67d-94bf-47bf-b8a3-c3f65d328cc6", platform: "tumblr", label: "lazyrelay" },
];

interface UploadResult {
  url: string;
}

interface ScheduleResult {
  accountLabel: string;
  platform: string;
  index: number;
  scheduledFor: string;
  status: "ok" | "upload_failed" | "schedule_failed";
  error?: string;
  postId?: string;
}

// Tiny concurrency-limited runner -- no library needed for this one-off.
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

async function uploadImage(platform: string, filePath: string): Promise<UploadResult> {
  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: "image/jpeg" }), path.basename(filePath));
  const res = await fetch(`${BACKEND_URL}/media/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  const json = (await res.json()) as { url?: string; error?: string };
  if (!res.ok || !json.url) throw new Error(json.error ?? `upload failed HTTP ${res.status}`);
  return { url: json.url };
}

async function schedulePost(socialAccountId: string, content: string, mediaUrl: string, scheduledFor: string): Promise<{ id: string }> {
  const res = await fetch(`${BACKEND_URL}/scheduled-posts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ socialAccountId, content, mediaUrl, scheduledFor }),
  });
  const json = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || !json.id) throw new Error(json.error ?? `schedule failed HTTP ${res.status}`);
  return { id: json.id };
}

// Optional cap for a small real dry-run before committing to the full
// batch (e.g. LIMIT_IMAGES=2 LIMIT_ACCOUNTS=1) -- unset for the real run.
const LIMIT_IMAGES = process.env.LIMIT_IMAGES ? Number(process.env.LIMIT_IMAGES) : undefined;
const LIMIT_ACCOUNTS = process.env.LIMIT_ACCOUNTS ? Number(process.env.LIMIT_ACCOUNTS) : undefined;

async function main() {
  const accounts = LIMIT_ACCOUNTS ? ACCOUNTS.slice(0, LIMIT_ACCOUNTS) : ACCOUNTS;
  const uniquePlatforms = [...new Set(accounts.map((a) => a.platform))];
  console.log(`Platforms: ${uniquePlatforms.join(", ")}`);
  console.log(`Accounts: ${accounts.length}`);

  // Phase 1: upload each platform's 84 real images ONCE, reused across
  // every account on that platform (facebook and pinterest each have 2).
  const platformImageUrls: Record<string, string[]> = {};
  for (const platform of uniquePlatforms) {
    const dir = path.join(IMAGE_ROOT, platform);
    let files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".jpg"))
      .sort();
    if (LIMIT_IMAGES) files = files.slice(0, LIMIT_IMAGES);
    console.log(`\n[${platform}] uploading ${files.length} images...`);
    const urls = await runWithConcurrency(files, 6, async (file, i) => {
      const result = await uploadImage(platform, path.join(dir, file));
      if ((i + 1) % 20 === 0 || i === files.length - 1) {
        console.log(`  [${platform}] ${i + 1}/${files.length} uploaded`);
      }
      return result.url;
    });
    platformImageUrls[platform] = urls;
  }

  fs.writeFileSync(
    path.join(import.meta.dirname, "..", "..", "schedule-launch-ad-batch-uploads.json"),
    JSON.stringify(platformImageUrls, null, 2),
  );
  console.log("\nAll uploads done, URLs saved.");

  // Phase 2: schedule 84 posts per account, 4 hours apart, cycling
  // through the 9 real captions.
  const startTime = Date.now() + START_DELAY_MS;
  const results: ScheduleResult[] = [];
  for (const account of accounts) {
    const urls = platformImageUrls[account.platform];
    console.log(`\n[${account.platform} / ${account.label}] scheduling ${urls.length} posts...`);
    const accountResults = await runWithConcurrency(urls, 6, async (mediaUrl, i) => {
      const scheduledFor = new Date(startTime + i * HOURS_BETWEEN * 60 * 60 * 1000).toISOString();
      const content = CAPTIONS[i % CAPTIONS.length];
      try {
        const { id } = await schedulePost(account.id, content, mediaUrl, scheduledFor);
        return { accountLabel: account.label, platform: account.platform, index: i, scheduledFor, status: "ok", postId: id } as ScheduleResult;
      } catch (err) {
        return {
          accountLabel: account.label,
          platform: account.platform,
          index: i,
          scheduledFor,
          status: "schedule_failed",
          error: err instanceof Error ? err.message : String(err),
        } as ScheduleResult;
      }
    });
    results.push(...accountResults);
    const okCount = accountResults.filter((r) => r.status === "ok").length;
    console.log(`  [${account.platform} / ${account.label}] ${okCount}/${urls.length} scheduled`);
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  }

  const totalOk = results.filter((r) => r.status === "ok").length;
  const totalFailed = results.length - totalOk;
  console.log(`\nDONE. ${totalOk}/${results.length} scheduled successfully. ${totalFailed} failed.`);
  if (totalFailed > 0) {
    console.log("Failures:", results.filter((r) => r.status !== "ok"));
  }
}

main().catch((err) => {
  console.error("Batch failed:", err);
  process.exit(1);
});
