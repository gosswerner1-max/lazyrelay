import { validateMediaForPlatform } from "./mediaLimits.js";

// Pure unit test — no DB needed, this exercises the validation logic
// directly against known-good and known-bad cases per platform.

const MB = 1024 * 1024;
let pass = true;

function expect(label: string, actual: boolean, expected: boolean) {
  if (actual !== expected) {
    console.error(`FAIL: ${label} — expected valid=${expected}, got valid=${actual}`);
    pass = false;
  } else {
    console.log(`PASS: ${label}`);
  }
}

// --- Instagram (meta) image: oversized ---
expect(
  "meta image over 8MB rejected",
  validateMediaForPlatform("meta", { mimeType: "image/jpeg", sizeBytes: 9 * MB, width: 1080, height: 1080 }).valid,
  false
);

// --- Instagram (meta) image: valid feed square ---
expect(
  "meta image within size + dimension + aspect-ratio range accepted",
  validateMediaForPlatform("meta", { mimeType: "image/jpeg", sizeBytes: 2 * MB, width: 1080, height: 1080 }).valid,
  true
);

// --- Instagram (meta) image: aspect ratio too extreme ---
expect(
  "meta image with 3:1 aspect ratio rejected (outside 4:5-1.91:1)",
  validateMediaForPlatform("meta", { mimeType: "image/jpeg", sizeBytes: 2 * MB, width: 1500, height: 500 }).valid,
  false
);

// --- Instagram (meta) image: width below the 320px floor ---
expect(
  "meta image narrower than 320px rejected",
  validateMediaForPlatform("meta", { mimeType: "image/jpeg", sizeBytes: 1 * MB, width: 200, height: 200 }).valid,
  false
);

// --- Wrong format for a platform ---
expect(
  "pinterest image in an unsupported format (gif) rejected",
  validateMediaForPlatform("pinterest", { mimeType: "image/gif", sizeBytes: 1 * MB, width: null, height: null }).valid,
  false
);

// --- TikTok photo: valid ---
expect(
  "tiktok jpeg photo under 20MB accepted",
  validateMediaForPlatform("tiktok", { mimeType: "image/jpeg", sizeBytes: 5 * MB, width: 1080, height: 1080 }).valid,
  true
);

// --- TikTok video: this is the exact scenario from the conversation —
// a video too large for the platform, using TikTok's real 4GB cap ---
expect(
  "tiktok video over 4GB rejected",
  validateMediaForPlatform("tiktok", {
    mimeType: "video/mp4",
    sizeBytes: 5 * 1024 * MB,
    width: null,
    height: null,
  }).valid,
  false
);

// --- TikTok video: valid, well under the cap ---
expect(
  "tiktok video under 4GB accepted",
  validateMediaForPlatform("tiktok", { mimeType: "video/mp4", sizeBytes: 50 * MB, width: null, height: null }).valid,
  true
);

// --- Video duration/resolution correctly flagged as unchecked, not silently claimed clean ---
const videoResult = validateMediaForPlatform("tiktok", {
  mimeType: "video/mp4",
  sizeBytes: 50 * MB,
  width: null,
  height: null,
});
if (!videoResult.unchecked.includes("video duration")) {
  console.error('FAIL: video result should flag "video duration" as unchecked, not silently pass it.');
  pass = false;
} else {
  console.log("PASS: video duration correctly flagged as unchecked, not silently claimed validated.");
}

console.log(pass ? "\nOVERALL: PASS" : "\nOVERALL: FAIL");
if (!pass) process.exit(1);
