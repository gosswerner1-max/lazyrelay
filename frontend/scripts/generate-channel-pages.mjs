#!/usr/bin/env node
// Generates one static marketing page per platform: frontend/public/schedule-to-<slug>/index.html
// plus frontend/scripts/channel-pages-manifest.json.
//
// Regenerate with:   node frontend/scripts/generate-channel-pages.mjs
//
// Facts come from the repo, never from memory:
//   - backend/src/platformRules.ts  (run through backend/node_modules/.bin/tsx, printed as JSON)
//     drives every number: text limit, image and video formats and sizes, multi-image limit,
//     durations, rolling post cap, source links and the "not verified" wording.
//   - frontend/src/pages/ConnectForm.tsx        -> steps for the paste-a-credential platforms
//   - backend/src/support/chatKnowledge.ts      -> customer-facing caveats (LinkedIn profile only,
//     Mastodon = mastodon.social only, Bluesky app password, WordPress = own self-hosted site,
//     Hashnode needs Pro plan, ...)
//   - backend/src/platforms/<name>.ts verifyPublished() -> what Proof-of-Publish really checks
//
// The plain-language wording per platform lives in COPY below. Numbers in COPY are filled in from
// the rules wherever possible. A signature of each platform's rules is stored in COPY_SIGS: when
// platformRules.ts changes, this script prints a warning naming the platforms whose wording needs a
// re-read (run with --print-sigs to refresh the signatures after you have reviewed the copy).
//
// No em dash or en dash characters are allowed in the output; the script refuses to write if any appear.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "..");
const BACKEND = resolve(FRONTEND, "..", "backend");
const PUBLIC_DIR = join(FRONTEND, "public");
const RULES_TS = join(BACKEND, "src", "platformRules.ts");
const SITE = "https://lazyrelay.com";

// ---------------------------------------------------------------------------------------------
// 1. Load the platform rules (TypeScript, so run it with the backend's own tsx)
// ---------------------------------------------------------------------------------------------
function loadRules() {
  const tsxCli = join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "lazyrelay-rules-"));
  try {
    const entry = join(tmp, "dump.mts");
    writeFileSync(entry, `import { getPlatformRules } from ${JSON.stringify(pathToFileURL(RULES_TS).href)};\nprocess.stdout.write(JSON.stringify(getPlatformRules()));\n`);
    // platformRules.ts pulls in modules that import the database client, which insists on these two
    // variables existing. The placeholders are never used: nothing here opens a connection.
    const out = execFileSync(process.execPath, [tsxCli, entry], {
      cwd: BACKEND,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, SUPABASE_URL: "http://localhost:1", SUPABASE_SERVICE_ROLE_KEY: "placeholder" },
    });
    return JSON.parse(out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function rulesCheckedDate() {
  const src = readFileSync(RULES_TS, "utf8");
  const m = /official docs on (\d{4}-\d{2}-\d{2})/.exec(src.replace(/\r?\n\/\/\s*/g, " "));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------
// 2. Small formatting helpers
// ---------------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtSize = (mb) => (mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`);
const fmtFormats = (f) => f.map((x) => x.toUpperCase()).join(", ");
const fmtDuration = (sec) => {
  if (sec % 60 === 0 && sec >= 120) return `${sec / 60} minutes`;
  return `${sec} seconds`;
};
const capFromNote = (r) => {
  const m = /over (\d+) characters/.exec(r.text.note);
  return m ? Number(m[1]) : null;
};
const sig = (r) =>
  createHash("sha1")
    .update(JSON.stringify({ t: r.text.maxLength, tn: r.text.note, m: r.media, o: r.options, f: r.features, l: r.limits, n: r.notes }))
    .digest("hex")
    .slice(0, 12);

// Sentence for the text limit when the rules have a number, or an honest "not verified" when they do not.
function textLine(r, label, extra = "") {
  if (r.text.maxLength != null) return `Text: up to ${r.text.maxLength} characters.${extra ? " " + extra : ""}`;
  const cap = capFromNote(r);
  return `Text: ${label} publishes no post length limit that LazyRelay could verify, so this page does not state one (not verified). LazyRelay itself refuses posts over ${cap} characters.${extra ? " " + extra : ""}`;
}

function mediaLines(r, opts = {}) {
  const m = r.media;
  const lines = [];
  if (!m.textOnlyAllowed) lines.push(opts.needs ?? "A post needs an image or a video. Text-only posts are not accepted.");
  else lines.push("Text-only posts are accepted.");
  if (m.image.supported) {
    lines.push(`Images: ${fmtFormats(m.image.formats)}, up to ${fmtSize(m.image.maxSizeMb)} each.${opts.imageNote ? " " + opts.imageNote : ""}`);
  } else {
    lines.push("Images: not supported.");
  }
  if (m.video.supported) {
    const dur = m.video.maxDurationSec != null ? `, up to ${fmtDuration(m.video.maxDurationSec)}` : ", duration limit not verified";
    lines.push(`Video: ${fmtFormats(m.video.formats)}, up to ${fmtSize(m.video.maxSizeMb)}${dur}.${opts.videoNote ? " " + opts.videoNote : ""}`);
  } else {
    lines.push("Video: not supported.");
  }
  if (m.multiItem) {
    lines.push(`Several files in one post: up to ${m.multiItem.maxItems} ${m.multiItem.videosAllowed ? "images or videos" : "images"}${m.multiItem.videosAllowed ? "" : " (no video in a multi-image post)"}.`);
  } else {
    lines.push("Several files in one post: not supported, one file per post.");
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// 3. Plain-language copy, one entry per platform. Facts are quoted from the repo; see header.
// ---------------------------------------------------------------------------------------------
const OAUTH_STEPS = (label) => [
  "Sign in to LazyRelay and open the Social Platforms tab in the top menu.",
  `Click the ${label} tile.`,
  `Sign in to ${label} when asked, and approve all of the permissions LazyRelay requests. Approving only some of them can make posting stop working later.`,
  "You land back in LazyRelay with the account connected. If you are logged in to several accounts on that platform in the same browser, log out of the ones you do not want first, so LazyRelay does not connect the wrong one.",
];

const COPY = {
  facebook: {
    slug: "facebook",
    label: "Facebook",
    desc: "Schedule posts to your Facebook Page with LazyRelay: photos, video, Stories and a first comment, each read back from Facebook to confirm it is live.",
    intro: "LazyRelay schedules posts to a Facebook Page you manage, then reads each one back from Facebook to confirm it really went live.",
    connect: (r) => OAUTH_STEPS("Facebook").concat(["LazyRelay posts to the Facebook Page you connect. Personal profiles and Facebook Groups are not supported."]),
    post: (r) => [
      textLine(r, "Facebook", "Facebook's Page feed documentation states no limit."),
      ...mediaLines(r, { imageNote: "This is LazyRelay's general image limit, not a figure published by Facebook (not verified).", videoNote: "Meta publishes no fixed video size limit, so LazyRelay uses 300 MB." }),
      "Story: choose Story instead of Feed under Platform options. A Story is one image or one video, with no extra files.",
      "First comment: LazyRelay can post a comment of your own right after the post goes out, up to 2200 characters. This is handy for hashtags.",
      "Self-reply: you can have LazyRelay add a reply from your Page once the post reaches a number of likes you choose.",
    ],
    pop: "After Facebook accepts the post, LazyRelay asks Facebook for that post again using the Page's own access and confirms Facebook returns it with a public link. Facebook can be slow to show a brand-new object, so LazyRelay checks several times over a short window instead of failing on the first try. For videos it also waits until Facebook reports the video as ready, not just uploaded. For a Story it looks for the Story in the Page's list of Stories. Only when that read-back succeeds is the post marked confirmed live.",
    caveats: [
      "Posts go to a Facebook Page, not a personal profile. Facebook Groups are not supported, and tagging another Page in a post is not supported.",
      "If posting silently stops after working for a while, reconnect Facebook from the Social Platforms tab and approve every permission, because a permission may have been switched off on Facebook's side.",
      "Facebook's own posting rate limit is not verified, and LazyRelay does not add a cap of its own for Facebook.",
    ],
    faq: (r) => [
      ["Can I schedule to my personal Facebook profile or a Facebook Group?", "No. LazyRelay posts to Facebook Pages only. Personal profiles and Groups are not supported."],
      ["Can I schedule Facebook Stories?", "Yes. Choose Story under Platform options. A Story takes one image or one video and no extra files."],
      ["Can LazyRelay add a first comment to my Facebook post?", "Yes, up to 2200 characters, posted right after the main post. A reply at a number of likes you choose is also available."],
      ["How do I know my Facebook post is really live?", "LazyRelay reads the post back from Facebook after sending it and only marks it confirmed live when Facebook returns it with a public link."],
    ],
  },

  instagram: {
    slug: "instagram",
    label: "Instagram",
    desc: "Schedule Instagram posts, carousels, Reels, Stories and trial Reels with LazyRelay. Each post is read back from Instagram to confirm it is live.",
    intro: "LazyRelay schedules feed posts, carousels, Reels, Stories and trial Reels to Instagram, then reads each post back from Instagram to confirm it is live.",
    connect: () => OAUTH_STEPS("Instagram").concat(["Your Instagram account needs to be a Business or Creator account. With the older connect flow it also has to be linked to a Facebook Page you administer."]),
    post: (r) => [
      textLine(r, "Instagram", "The caption allows at most 30 hashtags and 20 @mentions. Stories carry no caption."),
      ...mediaLines(r, {
        needs: "A post needs an image or a video. Text-only posts are refused.",
        imageNote: "Instagram wants JPEG. Feed images must be between 4:5 and 1.91:1 and 320 to 1440 pixels wide.",
        videoNote: "A single video posts as a Reel or a Story, not to the feed. Reels run 3 seconds to 15 minutes, with 9:16 recommended. Story video is 3 to 60 seconds and limited to 100 MB by Meta.",
      }),
      "Post as: choose Feed, Reel or Story under Platform options. A carousel takes up to 10 images or videos, and all images are cropped to the first image's ratio (1:1 by default).",
      "Trial Reel: a trial Reel shows your Reel to people who do not follow you first. It works for a single video Reel only. You can choose manual or automatic graduation to regular followers.",
      "First comment: LazyRelay can post a comment of your own right after the post, up to 2200 characters, which suits the hashtags-in-first-comment habit.",
      "Self-reply: LazyRelay can add a reply once the post reaches a number of likes you choose. It checks when it next reads your post's numbers, not the instant the count is reached.",
    ],
    pop: "After Instagram accepts the post, LazyRelay asks Instagram's own API for that media object using the account's access and confirms it comes back with a permalink. Only then is the post marked confirmed live, and that permalink is the link you can share. Instagram's publish step returning an ID is not treated as proof on its own.",
    caveats: [
      "Instagram has stricter media rules than Facebook, so a photo that posts fine on Facebook can be refused here. LazyRelay checks size and format before scheduling and tells you which limit was hit.",
      "Instagram itself allows 100 API-published posts in a rolling 24 hours, and a carousel counts as one. Meta's carousel section of the same page says 50, so treat 50 as the safe number. LazyRelay applies the 100 limit for you: a post that would be the 101st in 24 hours is refused when you schedule it, and you are told the next free time.",
      "Image size and video size figures follow Meta's documentation. Video length and resolution are not checked in advance, so a file inside the size limit can still be rejected by Instagram.",
    ],
    faq: () => [
      ["Does LazyRelay post Instagram Reels and Stories?", "Yes. Choose Post as Reel or Story under Platform options. A single video posts as a Reel or a Story, not as a feed post. Stories carry no caption."],
      ["Can I schedule an Instagram carousel?", "Yes, up to 10 images or videos in one post. All images are cropped to the first image's ratio, which is 1:1 by default."],
      ["What kind of Instagram account do I need?", "A Business or Creator account. With the older connect flow it also has to be linked to a Facebook Page you administer."],
      ["How do I know my Instagram post is really live?", "LazyRelay reads the media object back from Instagram after publishing and only marks the post confirmed live when Instagram returns it with a permalink."],
    ],
  },

  tiktok: {
    slug: "tiktok",
    label: "TikTok",
    desc: "Schedule TikTok videos with LazyRelay: pick the privacy level, control comments, duet and stitch, and get each post checked against TikTok's own status.",
    intro: "LazyRelay schedules videos to TikTok and then follows TikTok's own publish status until it reports the video as complete.",
    connect: () => OAUTH_STEPS("TikTok"),
    post: (r) => [
      "TikTok posts are video only. Photo posts and text-only posts are not supported by LazyRelay's TikTok connection.",
      textLine(r, "TikTok", "LazyRelay sends your post text as the video title."),
      `Video: ${fmtFormats(r.media.video.formats)}. TikTok's own limit is up to ${fmtSize(r.media.video.maxSizeMb)} and ${fmtDuration(r.media.video.maxDurationSec)} through the upload route, but LazyRelay's own upload limit is 1 GB, so 1 GB is the practical ceiling. Frame rate 23 to 60 fps, 360 to 4096 pixels per side.`,
      "Privacy level: you must choose one for every post, and there is no default. The choices are Everyone, Friends (mutual followers), or Only me. The levels offered depend on the TikTok account. A post marked as branded content cannot be set to Only me.",
      "Interactions: comments, duet and stitch are switched off by default. You can switch them on per post.",
      "Disclosure and labels: you can mark a post as commercial content, and you can label a video as AI-generated.",
      "Not available: choosing a custom cover frame, and picking trending sounds. LazyRelay posts the video as uploaded.",
    ],
    pop: "TikTok publishes in the background, so LazyRelay cannot read the video back straight away. Instead it checks TikTok's own publish status for that post repeatedly over a bounded wait and only marks the post confirmed live when TikTok reports the publish as complete. A public post then gets a public link. A post you set to Only me completes but has no public link to share. If TikTok is still processing when LazyRelay stops waiting, the post is not marked confirmed. TikTok can also moderate a video after it reports success, so a video can still disappear minutes later.",
    caveats: [
      "TikTok's access is short lived and normally refreshes itself. If TikTok asks you to reconnect, for example after a password change, after you revoked access in TikTok, or after TikTok flagged unusual activity on the account, disconnect and reconnect the account in LazyRelay.",
      "A post that stays private is almost always a privacy setting: the TikTok account itself may be set to Private, or Only me was chosen in the post form.",
      "TikTok's own per-account posting cap is not verified, and LazyRelay does not add one of its own.",
    ],
    faq: () => [
      ["Can I schedule photo posts to TikTok with LazyRelay?", "No. LazyRelay's TikTok connection posts video only."],
      ["Why did my TikTok post stay private?", "Either the TikTok account is set to Private in TikTok, or Only me was chosen as the privacy level in the post form. Pick Everyone in the post form and check the account's privacy setting in TikTok."],
      ["Do I have to choose a privacy level for every TikTok post?", "Yes. There is no default, so you choose Everyone, Friends (mutual followers), or Only me each time. Comments, duet and stitch start switched off."],
      ["How do I know my TikTok post is really live?", "LazyRelay follows TikTok's own publish status and marks the post confirmed live only when TikTok reports it complete. TikTok can still moderate a video after that, so the status is a real check, not a guarantee forever."],
    ],
  },

  pinterest: {
    slug: "pinterest",
    label: "Pinterest",
    desc: "Schedule Pins to the board you choose with LazyRelay: image and video Pins with destination links, each read back from Pinterest to confirm it is live.",
    intro: "LazyRelay schedules image and video Pins to the board you choose, then reads each Pin back from Pinterest to confirm it exists.",
    connect: () => OAUTH_STEPS("Pinterest"),
    post: (r) => [
      "A Pin needs an image or a video. Text-only posts are not accepted.",
      `Text: LazyRelay sends the first 100 characters of your text as the Pin title and the first ${r.text.maxLength} characters as the description. Pinterest's own API allows a description up to 800 characters, a title up to 100 and alt text up to 500.`,
      `Images: ${fmtFormats(r.media.image.formats)}, up to ${fmtSize(r.media.image.maxSizeMb)}, at least 100 x 200 pixels.`,
      `Video: ${fmtFormats(r.media.video.formats)}, up to ${fmtSize(r.media.video.maxSizeMb)} (a Pinterest help-center figure with lower confidence), duration limit not verified. A video Pin also needs a cover image, which is a still picture.`,
      "Several files in one post: not supported, one image or video per Pin.",
      "Board: you choose which board each Pin goes to.",
      "Destination link: you can set where a click on the Pin leads, up to 2048 characters.",
      "Not available yet: choosing a section inside a board.",
    ],
    pop: "Creating a Pin on Pinterest is immediate, so there is no waiting period. After Pinterest says the Pin was created, LazyRelay asks Pinterest for that Pin by its ID and only marks the post confirmed live when Pinterest returns the same Pin. The link you can share is the Pin's own link.",
    caveats: [
      `LazyRelay allows up to ${"{cap}"} Pins a day per connected Pinterest account, counted over any rolling 24 hours rather than a calendar day. A new connection also ramps up: 1 a day until day 7, 2 a day until day 10, 3 a day until day 14, then the full cap. Scheduling a Pin that would go over is refused with a message giving the next free time.`,
      "Pinterest is strict with brand-new accounts and brand-new websites. For a new Pinterest account, post by hand first: 1 Pin a day for the first week, then 2, then 3, until it reaches 100 or more monthly views (about 2 weeks), then connect it. A real Pinterest rejection has read that only 10 posts in 24 hours are allowed.",
      "If Pinterest says it blocked a link because it may lead to spam, that is Pinterest's own decision about the website address. LazyRelay cannot lift or override it. You can ask Pinterest to review it in its Help Center under Appeals, then Pinterest blocked my site.",
      "If Pins that worked for weeks stop posting, the Pinterest access has probably expired: reconnect the account.",
    ],
    faq: (r) => [
      ["Can I choose which Pinterest board a Pin goes to?", "Yes. You pick the board for each Pin. Choosing a section inside a board is not available yet."],
      ["Can I schedule video Pins?", "Yes. A video Pin needs a cover image, which is a still picture shown before the video plays."],
      ["How many Pins can LazyRelay schedule in a day?", `Up to ${r.limits.rollingPostsPer24h} per connected Pinterest account in any rolling 24 hours. A newly connected account ramps up over its first 14 days, starting at 1 a day.`],
      ["How do I know my Pin is really live?", "LazyRelay asks Pinterest for the Pin by its ID after creating it and only marks the post confirmed live when Pinterest returns it."],
    ],
  },

  youtube: {
    slug: "youtube",
    label: "YouTube",
    desc: "Schedule YouTube video uploads with LazyRelay, with a custom title, privacy setting and tags. Each upload is checked against YouTube's own processing status.",
    intro: "LazyRelay schedules video uploads to your YouTube channel and follows YouTube's own processing status until the video is ready.",
    connect: () => OAUTH_STEPS("YouTube"),
    post: (r) => [
      "YouTube posts are video only. Images and text-only posts are not supported.",
      "Text: your post text becomes the video description, up to 5000 bytes, and it cannot contain the < or > characters. The title comes from the title option, or from the first 100 characters of your text if you leave it empty.",
      `Video: ${fmtFormats(r.media.video.formats)}. YouTube allows up to ${fmtSize(r.media.video.maxSizeMb)}, but LazyRelay's own upload limit is 1 GB, so 1 GB is the practical ceiling. A duration limit is not verified. A channel that is not verified with YouTube can only upload videos up to 15 minutes long, and LazyRelay cannot check that in advance.`,
      "Title: up to 100 characters.",
      "Visibility: public, unlisted or private.",
      "Made for kids: a yes or no flag.",
      "Tags: up to 15 tags of up to 30 characters each. YouTube also applies a 500 character combined limit across all tags.",
      "AI-generated label: you can mark a video as AI-generated.",
    ],
    pop: "A new YouTube upload is processed in the background, so LazyRelay asks YouTube for the video's status several times over a bounded wait. It marks the post confirmed live when YouTube reports the upload as processed, and the link is the video's watch address. If YouTube reports the upload as rejected or failed, or is still processing when LazyRelay stops waiting, the post is not marked confirmed.",
    caveats: [
      "LazyRelay always does a standard upload. Whether YouTube then treats a video as a Short is YouTube's own decision, based on the video itself (vertical and under 3 minutes).",
      "YouTube restricts videos uploaded by an API project that has not passed YouTube's audit to private visibility. That is YouTube's rule, not a LazyRelay setting.",
      "YouTube's upload quota is not verified for this project, and LazyRelay does not add a cap of its own.",
    ],
    faq: () => [
      ["Can LazyRelay upload full-length YouTube videos, not just Shorts?", "Yes. Full-length videos work, up to LazyRelay's 1 GB upload limit. A channel that is not verified with YouTube can only upload videos up to 15 minutes."],
      ["Can I set a custom YouTube title, privacy and tags?", "Yes. You can set a title of up to 100 characters, public, unlisted or private visibility, the made for kids flag, up to 15 tags, and an AI-generated label."],
      ["Will LazyRelay make my video a Short?", "No. LazyRelay always does a standard upload. YouTube decides on its own whether a video counts as a Short."],
      ["How do I know my YouTube upload is really live?", "LazyRelay checks YouTube's own status for the video until it reports the upload as processed, and only then marks the post confirmed live."],
    ],
  },

  linkedin: {
    slug: "linkedin",
    label: "LinkedIn",
    desc: "Schedule LinkedIn posts with images or a PDF document to your personal profile with LazyRelay, with an honest note on how far LinkedIn lets a post be checked.",
    intro: "LazyRelay schedules text, image and PDF document posts to your personal LinkedIn profile.",
    connect: () => OAUTH_STEPS("LinkedIn").concat(["LinkedIn posting is for your personal profile today."]),
    post: (r) => [
      textLine(r, "LinkedIn", "LinkedIn's Posts API only says an over-long post returns an error."),
      ...mediaLines(r, { imageNote: "This is LazyRelay's general image limit, not a figure published by LinkedIn (not verified).", videoNote: "" }),
      "PDF document: attach an https link that ends in .pdf under Platform options, with an optional document title of up to 100 characters. A post carries either images or a PDF document, not both.",
    ],
    pop: "LinkedIn's API gives LazyRelay a real post ID the moment the post is created, and LazyRelay then requests the post's public address. Here the check is weaker than on other platforms, and this page says so plainly: without a restricted LinkedIn permission that LazyRelay's connection does not use, nothing can confirm afterwards that a LinkedIn post is still there. So the check confirms that LinkedIn accepted the post and that its address does not come back as not found. A post that LinkedIn removes or filters after publishing cannot be detected this way.",
    caveats: [
      "LinkedIn posting is personal profile only today. Company Page posting, polls, articles, and tagging people in the caption are not supported.",
      "Video posting to LinkedIn is not supported yet. Posts carry images or a PDF document.",
      "LinkedIn's own posting limits are not verified, and LazyRelay does not add a cap of its own.",
    ],
    faq: () => [
      ["Can I post to a LinkedIn Company Page?", "Not today. LazyRelay posts to your personal LinkedIn profile only. Company Page posting, polls, articles, and tagging people in the caption are not supported."],
      ["Can I schedule a PDF document on LinkedIn?", "Yes. Attach a link to a PDF under Platform options. A post carries either a PDF or images, not both, and up to 9 images work in a multi-image post."],
      ["Can I schedule video to LinkedIn?", "Not yet. LazyRelay posts text, images and PDF documents to LinkedIn."],
      ["How strong is the live check on LinkedIn?", "Weaker than on most platforms. LazyRelay confirms LinkedIn accepted the post and that its address is not reported as missing, but it cannot detect a post LinkedIn removes later."],
    ],
  },

  threads: {
    slug: "threads",
    label: "Threads",
    desc: "Schedule Threads posts, carousels and reply chains with LazyRelay. Each post is read back from Threads to confirm it is live.",
    intro: "LazyRelay schedules Threads posts, carousels and multi-post threads, then reads each post back from Threads to confirm it is live.",
    connect: () => OAUTH_STEPS("Threads").concat(["Threads has its own connection, separate from Instagram and Facebook. Reconnecting Instagram does not refresh the Threads connection."]),
    post: (r) => [
      textLine(r, "Threads"),
      ...mediaLines(r, { imageNote: "Images should be 320 to 1440 pixels wide." }),
      `Carousel: up to ${r.media.multiItem.maxItems} items, the same limit as Threads' own documentation. A carousel can mix images and videos.`,
      "Thread chain: add up to 10 follow-up posts under Platform options. Each one replies to the one before it, and each is limited to 500 characters.",
    ],
    pop: "After Threads publishes a post, LazyRelay fetches that post back from Threads' own API using the account's access and confirms it comes back with a permalink. Only then is it marked confirmed live. In a thread chain, the follow-up posts are sent after the first post is confirmed live.",
    caveats: [
      "Threads allows 250 published posts per rolling 24 hours (Threads API documentation). LazyRelay does not add a cap of its own.",
      "Video must be MP4 or MOV, and the Threads documentation limits video to 300 seconds.",
    ],
    faq: () => [
      ["Does LazyRelay support Threads reply chains?", "Yes. Add up to 10 follow-up posts under Platform options. Each replies to the previous one, and each is limited to 500 characters."],
      ["Is Threads connected separately from Instagram?", "Yes. Threads has its own connection, so reconnecting Instagram or Facebook does not affect it."],
      ["How many characters can a Threads post have?", "500 characters per post, and the same for each follow-up in a chain."],
      ["How do I know my Threads post is really live?", "LazyRelay fetches the post back from Threads after publishing and marks it confirmed live only when it returns with a permalink."],
    ],
  },

  mastodon: {
    slug: "mastodon",
    label: "Mastodon",
    desc: "Schedule Mastodon posts with images, alt text and reply threads using LazyRelay. Connects to mastodon.social. Each post is read back to confirm it is live.",
    intro: "LazyRelay schedules public posts to your Mastodon account on mastodon.social, then reads each one back to confirm it is live.",
    connect: () => OAUTH_STEPS("Mastodon").concat(["Mastodon connects to mastodon.social only today. An account on a different Mastodon server cannot be connected yet."]),
    post: (r) => [
      textLine(r, "Mastodon", "That is the default on mastodon.social. Every Mastodon server sets its own limit, so another server may differ."),
      ...mediaLines(r, {
        imageNote: "That is Mastodon's documented default, and LazyRelay checks against the same figure.",
        videoNote: "The 99 MB figure matches mastodon.social. All media limits are set per server.",
      }),
      "Alt text: you can add a description of up to 1000 characters to your media.",
      "Thread chain: add up to 10 follow-up posts under Platform options. Each replies to the one before it and is limited to 500 characters.",
      "Not available: Content Warning (CW) labels.",
    ],
    pop: "Creating a status on Mastodon is immediate. After that, LazyRelay makes a separate request for that status using the account's access and only marks the post confirmed live when Mastodon returns the same status ID. The link is the status address Mastodon gives back.",
    caveats: [
      "Mastodon connects to mastodon.social only today. An account on another server, for example hachyderm.io, cannot be connected yet.",
      "Media limits are set per Mastodon server. LazyRelay's numbers are a fixed starting point that matches mastodon.social. Video duration is not verified.",
      "Rate limits are set per Mastodon server, and LazyRelay does not add a cap of its own.",
    ],
    faq: () => [
      ["Can I connect a Mastodon account on another server?", "Not yet. LazyRelay connects to mastodon.social only today."],
      ["Does LazyRelay support Mastodon alt text and threads?", "Yes. You can add alt text of up to 1000 characters, and up to 10 follow-up posts that reply in order. Content Warning labels are not supported."],
      ["How many characters fit in a Mastodon post?", "500 by default on mastodon.social. Each Mastodon server sets its own limit, so another server may differ."],
      ["How do I know my Mastodon post is really live?", "LazyRelay requests the status back from Mastodon after posting and only marks it confirmed live when Mastodon returns the same status."],
    ],
  },

  bluesky: {
    slug: "bluesky",
    label: "Bluesky",
    desc: "Schedule Bluesky posts with images, video, alt text and reply threads using LazyRelay and an app password. Each post is read back to confirm it is live.",
    intro: "LazyRelay schedules Bluesky posts, images, video and reply threads using an app password, then reads each post back to confirm it is live.",
    connect: () => [
      "Open bsky.app and go to Settings, then Privacy and security, then App passwords. Create a new app password. Do not use your main account password.",
      "In LazyRelay, open the Social Platforms tab and click the Bluesky tile.",
      "Enter your handle (for example you.bsky.social) and paste the app password.",
      "Click Connect. LazyRelay saves the connection and takes you back to your dashboard.",
    ],
    post: (r) => [
      textLine(r, "Bluesky", "That counts graphemes, which is what a person sees as a character, and the post is also capped at 3000 bytes."),
      ...mediaLines(r, {
        imageNote: "Bluesky limits each image to 2,000,000 bytes, which is about 1.9 MB, and LazyRelay checks the same limit before scheduling.",
        videoNote: "Video needs the account's email address to be confirmed. The 10 minute figure comes from LazyRelay's own media settings and was not re-checked against Bluesky's documentation.",
      }),
      "Alt text: you can add a description of up to 1000 characters. It applies to the first image only.",
      "Thread chain: add up to 10 follow-up posts under Platform options. Each replies to the one before it and is limited to 300 characters.",
    ],
    pop: "When a Bluesky post is created, the record is saved to your account, which is not quite the same as it being publicly visible. So LazyRelay reads that record back from Bluesky by its address and only marks the post confirmed live when Bluesky returns the same post. The link you can share is the bsky.app address of that post.",
    caveats: [
      "Bluesky needs an app password, not your main password. If you see Invalid App Password, that message comes from Bluesky itself: check the app password was typed in correctly.",
      "Self-hosted and third-party Bluesky servers (a personal data server, or PDS) are supported. Fill in the optional Server box on the connect page with the server address, for example pds.example.com. The server must be reachable on a public https address; private or local addresses are refused. A custom-domain handle works the same way on Bluesky's own servers or on yours.",
      "Bluesky's own posting limits are not verified, and LazyRelay does not add a cap of its own.",
    ],
    faq: () => [
      ["Why does Bluesky need an app password?", "LazyRelay connects to Bluesky with an app password, so you create a separate one in bsky.app under Settings, Privacy and security, App passwords. It keeps your main password out of LazyRelay and can be revoked at any time."],
      ["Does LazyRelay work with my custom domain handle?", "Yes. A custom-domain handle works whether the account is hosted on Bluesky's own servers or on a server you or someone else runs."],
      ["Does LazyRelay work with a self-hosted or third-party Bluesky server?", "Yes. If your account lives on your own server or a third-party one (a personal data server, or PDS), fill in the optional Server box on the Bluesky connect page with its address, for example pds.example.com. The server must be reachable on a public https address; private or local addresses are refused. Posts are confirmed live by reading them back from that same server."],
      ["How large can a Bluesky image be?", "2,000,000 bytes per image, which is about 1.9 MB. LazyRelay checks the same limit before a post is scheduled."],
      ["How do I know my Bluesky post is really live?", "LazyRelay reads the post record back from Bluesky after creating it and only marks it confirmed live when Bluesky returns that same post."],
    ],
  },

  telegram: {
    slug: "telegram",
    label: "Telegram",
    desc: "Schedule Telegram channel posts with text, a photo or a video using your own bot and LazyRelay. Learn how the post check works and where it is limited.",
    intro: "LazyRelay schedules text, photo and video posts to a public Telegram channel, through a bot that you create yourself.",
    connect: () => [
      "In Telegram, message @BotFather, send /newbot, and follow the prompts. It gives you a bot token.",
      "Make sure your channel is public, so it has an @username. Add your bot to that channel as an administrator with the Post Messages permission.",
      "In LazyRelay, open the Social Platforms tab and click the Telegram tile.",
      "Paste the bot token and type the channel username, for example @yourchannel.",
      "Click Connect. LazyRelay checks the bot token and that the bot can post in the channel, then saves the connection.",
    ],
    post: (r) => [
      textLine(r, "Telegram", "When a photo or video is attached, your text becomes the caption, which is limited to 1024 characters."),
      ...mediaLines(r, { imageNote: "", videoNote: "The 50 MB video ceiling is Telegram's own limit on the standard Bot API." }),
      "Posts go to the public channel you connected.",
    ],
    pop: "Telegram is the platform where the live check is most limited, and this page says so plainly. Telegram's bot system has no way to fetch an individual message back by its ID. So LazyRelay counts Telegram's own reply, which includes the message ID, as proof the send worked, and then re-checks that the channel is still reachable and that your bot still has access to it. If the bot was removed as an administrator or the channel is gone, the post is not marked confirmed. What LazyRelay cannot do is re-read that specific message afterwards.",
    caveats: [
      "Only public channels are supported. Private groups are not supported.",
      "Each customer connects their own bot, and the bot needs the Post Messages permission in the channel.",
      "Telegram's own limits are not verified, and LazyRelay does not add a cap of its own.",
    ],
    faq: () => [
      ["Do I need my own Telegram bot?", "Yes. You create one in a minute by messaging @BotFather, then add it to your channel as an administrator with the Post Messages permission."],
      ["Can I post to a private Telegram group?", "No. Only public channels with an @username are supported."],
      ["How long can a Telegram post be?", "4096 characters for a text message. When a photo or video is attached, the text becomes a caption of up to 1024 characters."],
      ["How does LazyRelay check a Telegram post is live?", "Telegram cannot return a single message by its ID, so LazyRelay uses Telegram's own send confirmation and then re-checks that the channel is reachable and the bot still has access. It cannot re-read that exact message afterwards."],
    ],
  },

  discord: {
    slug: "discord",
    label: "Discord",
    desc: "Schedule Discord channel posts with text, images or video using a channel webhook and LazyRelay. Each message is read back to confirm it is live.",
    intro: "LazyRelay schedules messages to a Discord channel using a webhook you create, then reads each message back to confirm it is there.",
    connect: () => [
      "In Discord, open the channel you want to post to and go to Channel Settings, then Integrations, then Webhooks, then New Webhook.",
      "Copy the webhook URL.",
      "In LazyRelay, open the Social Platforms tab and click the Discord tile.",
      "Paste the webhook URL and click Connect.",
      "Optional: the connect page also has a link to invite the LazyRelay bot to your server, if you want to reply to comments from LazyRelay too. Posting works either way.",
    ],
    post: (r) => [
      textLine(r, "Discord", "Standard Discord Markdown such as bold, italics and code works."),
      ...mediaLines(r, { imageNote: "", videoNote: "The real upload limit depends on the destination server's boost tier. 20 MB is the floor every server supports, and it is what LazyRelay enforces." }),
      "Posts go to the channel behind the webhook you pasted.",
    ],
    pop: "After Discord accepts the message, LazyRelay asks Discord for that message by its ID through the same webhook and only marks the post confirmed live when Discord returns it. It also looks up the webhook's server so the link it gives you jumps straight to the message.",
    caveats: [
      "Posting is webhook based, not a bot sitting in your server, so messages show as sent via Webhook instead of under a named bot. That is expected.",
      "Discord's webhook rate limits are not verified, and LazyRelay does not add a cap of its own.",
    ],
    faq: () => [
      ["Do I need to add a bot to my Discord server?", "No. Posting works through a channel webhook. The bot invitation on the connect page is optional and only matters if you want to reply to comments from LazyRelay too."],
      ["Why does my post say via Webhook?", "Because posting goes through a channel webhook rather than a bot. That is expected."],
      ["How big can a Discord upload be?", "LazyRelay enforces 20 MB, which every Discord server supports. A server with a higher boost tier allows more, but LazyRelay uses the 20 MB floor."],
      ["How do I know my Discord message is really there?", "LazyRelay fetches the message back from Discord by its ID after sending it and marks the post confirmed live only when Discord returns it."],
    ],
  },

  tumblr: {
    slug: "tumblr",
    label: "Tumblr",
    desc: "Schedule Tumblr posts with photos and video using LazyRelay, then have each post read back from Tumblr to confirm it is live.",
    intro: "LazyRelay schedules text, photo and video posts to your Tumblr blog, then reads each post back from Tumblr to confirm it is live.",
    connect: () => OAUTH_STEPS("Tumblr").concat(["A Tumblr login can cover several blogs, but each connected account posts to a single blog. If you run more than one blog, check which one is connected before you rely on it."]),
    post: (r) => [
      textLine(r, "Tumblr"),
      ...mediaLines(r, { imageNote: "", videoNote: "This is a working number from an older Tumblr endpoint and is not verified for the current post format." }),
    ],
    pop: "After Tumblr accepts the post, LazyRelay asks Tumblr for that post using the blog name and post ID it saved, and only marks the post confirmed live when Tumblr returns it. The link you can share is the post address Tumblr gives back.",
    caveats: [
      "LazyRelay did not find a published Tumblr source for its limits, so every figure above is LazyRelay's own working number, not something Tumblr documents.",
      "Tumblr's own limits are not verified, and LazyRelay does not add a cap of its own.",
    ],
    faq: (r) => [
      ["Can I post to more than one Tumblr blog?", "A Tumblr login can cover several blogs, but each connected account posts to one blog. Check which blog is connected before you rely on it."],
      ["Can LazyRelay schedule Tumblr photo and video posts?", `Yes. Photos, GIFs and video are accepted, and a multi-image post can hold up to ${r.media.multiItem.maxItems} images. The video size figure is not verified for Tumblr's current post format.`],
      ["Is there a Tumblr text length limit?", `Tumblr publishes no limit that LazyRelay could verify, so this page does not state one. LazyRelay itself refuses posts over ${capFromNote(r)} characters.`],
      ["How do I know my Tumblr post is really live?", "LazyRelay reads the post back from Tumblr after sending it and marks it confirmed live only when Tumblr returns it."],
    ],
  },

  wordpress: {
    slug: "wordpress",
    label: "WordPress",
    desc: "Schedule articles to your own self-hosted WordPress site with LazyRelay: title, categories, tags, featured image, and a live check of the public page.",
    intro: "LazyRelay schedules articles to your own self-hosted WordPress site, then checks that the public page really shows the post.",
    connect: () => [
      "You need your own self-hosted WordPress site, version 5.6 or newer, with an address that starts with https. WordPress.com hosted blogs are not supported.",
      "In WordPress go to Users, then Profile, and scroll to Application Passwords. Type LazyRelay as the name and click Add. Copy the password it shows, because it is shown only once. Do not use your normal login password.",
      "In LazyRelay, open the Social Platforms tab and click the WordPress tile.",
      "Enter your site address (for example https://yoursite.com), your WordPress username, and the application password. Click Connect.",
      "If connecting fails, some hosts and security plugins switch Application Passwords off or block them. In that case you need to allow them first.",
    ],
    post: (r) => [
      textLine(r, "WordPress", "The post text becomes the article body."),
      ...mediaLines(r, { imageNote: "Upload limits are set by each site's host, so your site may refuse a larger file." }),
      "Title: the first line of your post is the article title, unless you set a title under Platform options.",
      "Publish or draft: you can publish the article or save it as a draft on your site.",
      "Categories and tags: you can give lists of names, and LazyRelay creates any that are missing.",
      "Featured image: the first image becomes the featured image, and any extra images are added at the end of the article.",
    ],
    pop: "For WordPress, live means what a stranger can see. LazyRelay reads the article back from your site with the account's login and requires WordPress to say it is published, not a draft, not scheduled for later, not pending review, not private, and not password protected. It then requests the article's public address with no login and requires that page to answer successfully. A post saved as a draft is reported as saved as a draft, never as confirmed live.",
    caveats: [
      "Only self-hosted WordPress sites work. WordPress.com hosted blogs are not supported yet.",
      "A post saved as a draft is not public, so it is never marked confirmed live and it is not counted in analytics.",
      "Rate limits and upload limits depend on your site's host, and LazyRelay does not add a cap of its own.",
    ],
    faq: () => [
      ["Does this work with WordPress.com?", "No. LazyRelay works with your own self-hosted WordPress site, version 5.6 or newer, with an https address. WordPress.com hosted blogs are not supported yet."],
      ["How do I connect my WordPress site?", "Create an Application Password in WordPress under Users, then Profile, and paste it into LazyRelay with your site address and username. Do not use your normal login password."],
      ["Why can't I create an Application Password?", "Some hosts and security plugins switch Application Passwords off or block them, which makes connecting fail. You need to allow them on your site first."],
      ["How do I know my WordPress post is really live?", "LazyRelay reads the article back from your site, requires it to be published and not password protected, and then requests its public address with no login. A draft is reported as saved as a draft."],
    ],
  },

  devto: {
    slug: "devto",
    label: "dev.to",
    desc: "Schedule dev.to articles with LazyRelay: markdown, up to 4 tags, series, canonical link and draft mode, with the live page checked after publishing.",
    intro: "LazyRelay schedules markdown articles to dev.to using your API key, then checks that the article is really published and reachable.",
    connect: () => [
      "On dev.to open Settings, then Extensions, and find DEV Community API Keys.",
      "Type LazyRelay as the description and click Generate API Key. Copy the key.",
      "In LazyRelay, open the Social Platforms tab and click the dev.to tile.",
      "Paste the API key and click Connect.",
    ],
    post: (r) => [
      textLine(r, "dev.to", "The text is written in markdown."),
      ...mediaLines(r, { imageNote: "Images are shown by address: the first is the cover image and the rest appear inside the article. The size limit is LazyRelay's general figure, not a verified dev.to limit.", videoNote: "" }),
      "Title: the first line of your post is the title, unless you set a title under Platform options. LazyRelay caps titles at 250 characters, and dev.to publishes no title limit.",
      "Tags: up to 4.",
      "Series and canonical link: you can set a series, and an original address (an https link) if the article appeared elsewhere first.",
      "Draft: you can save the article as a draft instead of publishing it.",
    ],
    pop: "dev.to drafts do not show up publicly, so LazyRelay first looks for the article in your own list of articles, which includes drafts, and falls back to the public article page if needed. For a published article it then requests the public address with no credentials, the way a reader would, and requires that to answer successfully. A draft is reported as saved as a draft and never as confirmed live.",
    caveats: [
      "dev.to has no video upload through its API, so a video is refused.",
      "dev.to has no scheduling field, so LazyRelay publishes the article itself at the scheduled time.",
      "dev.to's rate limits are not documented, and LazyRelay does not add a cap of its own.",
      "A post saved as a draft is not public, so it is never marked confirmed live and it is not counted in analytics.",
    ],
    faq: () => [
      ["Does dev.to support scheduling?", "dev.to has no scheduling field of its own, so LazyRelay holds the article and publishes it at the time you set."],
      ["Can LazyRelay set tags, a series and a canonical link?", "Yes. You can set up to 4 tags, a series, and an original address that must be an https link."],
      ["Can I save a dev.to article as a draft?", "Yes. A draft is saved on dev.to and reported as saved as a draft. It is never marked confirmed live."],
      ["How do I know my dev.to article is really live?", "LazyRelay finds the article through your account, then requests its public address with no credentials and requires that page to answer successfully."],
    ],
  },

  hashnode: {
    slug: "hashnode",
    label: "Hashnode",
    desc: "Schedule Hashnode articles with LazyRelay: markdown, subtitle, up to 5 tags, canonical link and draft mode. Needs a blog on Hashnode's Pro plan.",
    intro: "LazyRelay schedules markdown articles to your Hashnode blog using a personal access token, then checks that the article is really public.",
    connect: () => [
      "Your blog needs Hashnode's Pro plan. Since May 2026 Hashnode charges for API access, and without it connecting and posting fail.",
      "On Hashnode open Account settings, then Developer, click Generate New Token, and copy the token.",
      "In LazyRelay, open the Social Platforms tab and click the Hashnode tile.",
      "Paste the personal access token. If you have more than one blog, also enter the blog address, for example yourname.hashnode.dev.",
      "Click Connect.",
    ],
    post: (r) => [
      textLine(r, "Hashnode", "The text is written in markdown."),
      ...mediaLines(r, { imageNote: "The first image is the cover and the rest appear inside the article. The size limit is LazyRelay's general figure, not verified.", videoNote: "" }),
      "Title and subtitle: the first line of your post is the title, unless you set a title under Platform options. You can also add a subtitle.",
      "Tags: up to 5.",
      "Canonical link: you can set an original address (an https link) if the article appeared elsewhere first.",
      "Draft: you can save the article as a draft instead of publishing it.",
    ],
    pop: "LazyRelay reads the article back from Hashnode and requires that it has a public address and a publish time that has already passed. It then requests that address the way an ordinary visitor would, with no token, and requires a successful answer from the article's own page. A draft is checked to exist and then reported as saved as a draft, never as confirmed live.",
    caveats: [
      "Hashnode charges for API access since May 2026, so the blog must be on Hashnode's Pro plan or connecting and posting fail.",
      "Hashnode has no video upload here, so a video is refused.",
      "Hashnode's post length limit and rate limits are not verified, and LazyRelay does not add a cap of its own.",
      "A post saved as a draft is not public, so it is never marked confirmed live and it is not counted in analytics.",
    ],
    faq: () => [
      ["Do I need a paid Hashnode plan?", "Yes. Since May 2026 Hashnode charges for API access, so your blog must be on Hashnode's Pro plan for LazyRelay to connect and post."],
      ["Can I post to a specific blog if I have several?", "Yes. When you connect, enter the blog address, for example yourname.hashnode.dev. You only need it if you have more than one blog."],
      ["Can I save a Hashnode article as a draft?", "Yes. A draft is saved on Hashnode and reported as saved as a draft. It is never marked confirmed live."],
      ["How do I know my Hashnode article is really live?", "LazyRelay reads the article back, requires a public address and a publish time that has passed, then requests that address with no token and requires a successful answer."],
    ],
  },

  lemmy: {
    slug: "lemmy",
    label: "Lemmy",
    desc: "Schedule Lemmy posts to the community you choose with LazyRelay: title, markdown body, link posts and images, with a check that strangers can see the post.",
    intro: "LazyRelay schedules posts to a Lemmy community on your own server, then checks that the post is visible to people who are not logged in.",
    connect: () => [
      "In Lemmy open Settings, then Profile, and tick Bot account. Lemmy expects automated posts to come from an account marked as a bot.",
      "In LazyRelay, open the Social Platforms tab and click the Lemmy tile.",
      "Enter your Lemmy server (for example lemmy.world), your username and your password. Add your two-factor code only if you use one.",
      "Optionally enter a default community, for example programming@programming.dev.",
      "Click Connect. LazyRelay keeps a login token, not your password.",
    ],
    post: (r) => [
      "Title and body: the first line of your post is the title, up to 200 characters, unless you set a title under Platform options. The rest is the body, written in markdown, up to 10000 characters (LazyRelay's own cap).",
      ...mediaLines(r, { imageNote: "An image is uploaded to your Lemmy server, and each server sets its own upload limit.", videoNote: "" }),
      "Community: each post goes to one community, written as name or name@server. Under Platform options you can set it per post, unless you saved a default when connecting.",
      "Link post: you can share an https link.",
      "NSFW flag: you can mark a post as NSFW.",
    ],
    pop: "LazyRelay reads the post back from your server with your account, refuses a post that is removed or deleted, then repeats the read with no login to see what a stranger sees. It also requests the post's public page and requires a successful answer. The page alone would prove little, because Lemmy's web app can answer successfully for any post number. If a moderator removes your post, LazyRelay reports it as not live.",
    caveats: [
      "Each community has its own rules, and a moderator can remove a post. LazyRelay reports a removed post as not live.",
      "Lemmy expects automated posts to come from an account marked as a bot (Settings, Profile, Bot account).",
      "Each Lemmy server sets its own rate limits and upload limits, and LazyRelay does not add a cap of its own.",
    ],
    faq: () => [
      ["Why does Lemmy ask me to tick Bot account?", "Lemmy expects automated posts to come from an account marked as a bot. Tick it under Settings, then Profile before you connect."],
      ["Does LazyRelay store my Lemmy password?", "No. LazyRelay keeps a login token, not your password."],
      ["What happens if a moderator removes my Lemmy post?", "LazyRelay's check reads the post back and reports a removed post as not live, instead of leaving it marked as published."],
      ["Can I post to any Lemmy community?", "You post to one community at a time, written as name or name@server, on the server you connected. Each community has its own rules."],
    ],
  },

  slack: {
    slug: "slack",
    label: "Slack",
    desc: "Schedule text posts to a public Slack channel with LazyRelay, and get a link to the live message as proof that it was posted.",
    intro: "LazyRelay schedules text posts to one public channel in your Slack workspace, then asks Slack to confirm the message exists and saves the link to it.",
    connect: () => [
      "Sign in to LazyRelay and open the Social Platforms tab in the top menu.",
      "Click the Slack tile.",
      "Sign in to Slack if asked, choose your workspace, and approve the LazyRelay Slack app on Slack's own screen.",
      "Back in LazyRelay, pick the public channel LazyRelay should post to, then click Connect this channel.",
      "To post to another channel later, connect Slack again and pick that channel. Each connection is one workspace and one channel.",
    ],
    post: (r) => [
      textLine(r, "Slack", "Slack formats text its own way (*bold*, _italic_), not Markdown, and LazyRelay sends your text as you typed it. A link in the text shows a preview in Slack."),
      ...mediaLines(r, {}),
      "Channel: each connection posts to one public channel, chosen when you connect.",
      "Mentions: your text is escaped, so it can never ping @channel or @here, or mention anyone.",
    ],
    pop: "After the post is sent, LazyRelay asks Slack for the link to the message. The post only counts as live once Slack confirms that the message exists, and that link to the message in Slack is saved as your proof link. If Slack cannot confirm the message, the post is flagged instead of being marked as published.",
    caveats: [
      "Slack posts are text and links only for now. Images and videos are not supported and are refused when you schedule.",
      "Private channels are not offered when you connect. To post to a private channel, invite the LazyRelay app to it in Slack first.",
      "Some workspaces limit who can post in a channel, for example in #general. If that stops LazyRelay, a Slack admin has to allow it.",
      "Slack allows about one message per second per channel, and LazyRelay does not add a cap of its own.",
      "LazyRelay does not offer analytics, comment replies or direct messages for Slack.",
    ],
    faq: () => [
      ["Can I post images or video to Slack with LazyRelay?", "Not yet. Slack posts are text and links only, and a post with an image or video is refused when you schedule it."],
      ["Can I post to a private Slack channel?", "Private channels are not offered when you connect. If you want one, invite the LazyRelay app to that channel in Slack first."],
      ["Can a LazyRelay post ping my whole channel?", "No. LazyRelay escapes your text, so it can never ping @channel or @here, or mention a person."],
      ["How long can a Slack post be?", "Up to 4000 characters."],
      ["How do I know my Slack message is really there?", "LazyRelay asks Slack to confirm the message exists and saves the link to it as your proof. If Slack cannot confirm it, the post is flagged."],
    ],
  },
};

// Signatures of the rules each COPY entry was written against. Refresh with --print-sigs after review.
const COPY_SIGS = {
  "facebook": "b6b37c5319ed",
  "instagram": "4144e9508240",
  "tiktok": "b238f5500554",
  "pinterest": "b5cf154e6e1f",
  "youtube": "3904fc12fc79",
  "linkedin": "20efc5ae6239",
  "threads": "d78dffc46d92",
  "mastodon": "6446306ea48a",
  "bluesky": "10399ad313ec",
  "telegram": "b60a3a5e2ac0",
  "discord": "374b9650e712",
  "tumblr": "bbb0a3c2fb46",
  "wordpress": "97bc8d4831c5",
  "devto": "c2d4e69d73e7",
  "hashnode": "eabacaff6494",
  "lemmy": "3eae25a5934d",
  "slack": "50e49d1c1c5d"
};

// ---------------------------------------------------------------------------------------------
// 4. Page template, copying the structure, CSS, header/footer and JSON-LD of
//    frontend/public/mastodon-bluesky-tumblr-scheduler/index.html
// ---------------------------------------------------------------------------------------------
const ORDER = ["facebook", "instagram", "tiktok", "pinterest", "youtube", "linkedin", "threads", "mastodon", "bluesky", "telegram", "discord", "tumblr", "wordpress", "devto", "hashnode", "lemmy", "slack"];

const CSS = `  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f5f6f8; color: #5b6472; margin: 0; line-height: 1.65; }
  header, footer { max-width: 720px; margin: 0 auto; padding: 24px; }
  main { max-width: 720px; margin: 0 auto; padding: 0 24px 48px; background: #fff; }
  .wordmark { display: flex; align-items: center; gap: 8px; font-family: Georgia, serif; font-weight: 700; font-size: 20px; color: #14171f; }
  .wordmark .dot { color: #ff5630; }
  a { color: #ff5630; }
  a.back { display: inline-block; margin-bottom: 24px; text-decoration: none; color: #ff5630; }
  h1 { font-family: Georgia, serif; color: #14171f; font-size: 32px; margin-bottom: 8px; line-height: 1.25; }
  h2 { font-family: Georgia, serif; color: #14171f; font-size: 20px; margin-top: 36px; }
  h3 { font-family: Georgia, serif; color: #14171f; font-size: 16px; margin-top: 24px; margin-bottom: 4px; }
  .subtitle { color: #5b6472; font-size: 16px; margin-top: 0; margin-bottom: 32px; }
  .note { color: #5b6472; font-size: 14px; }
  strong { color: #14171f; }
  .cta-box { background: #f5f6f8; border-left: 3px solid #ff5630; padding: 20px 24px; margin: 32px 0; border-radius: 4px; }
  .cta-box a.button { display: inline-block; background: #ff5630; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px; }
  ul, ol { padding-left: 22px; }
  li { margin-bottom: 8px; }
  .faq-item { margin-bottom: 20px; }`;

function renderPage(c, r, all, checked) {
  const cap = r.limits.rollingPostsPer24h;
  const fill = (s) => s.replace("{cap}", String(cap));
  const url = `${SITE}/schedule-to-${c.slug}/`;
  const title = `Schedule Posts to ${c.label} with LazyRelay | LazyRelay`;
  const faq = c.faq(r);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };
  const li = (items) => items.map((t) => `  <li>${esc(fill(t))}</li>`).join("\n");
  const others = ORDER.filter((s) => s !== c.slug)
    .map((s) => `<a href="/schedule-to-${s}/">${esc(COPY[s].label)}</a>`)
    .join(" &middot; ");
  const sources = r.sources.length
    ? `<p class="note">Figures on this page come from LazyRelay's platform rules${checked ? `, checked on ${checked}` : ""}. Sources: ${r.sources.map((u) => `<a href="${esc(u)}" rel="noopener">${esc(u.replace(/^https?:\/\//, ""))}</a>`).join(", ")}. Anything marked not verified has no published source.</p>`
    : `<p class="note">Figures on this page come from LazyRelay's platform rules${checked ? `, checked on ${checked}` : ""}. No published source was found for ${esc(c.label)}'s limits, so anything marked not verified is LazyRelay's own working number.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(c.desc)}" />
<link rel="canonical" href="${url}" />
    <link rel="icon" type="image/png" href="/favicon.png" />
<link rel="stylesheet" href="/circuit-bg.css" />
<script src="/consent.js" defer></script>
<style>
${CSS}
</style>
<script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
</script>
</head>
<body>
<script src="/circuit-bg.js" defer></script>
<header><div class="wordmark">Lazy<span class="dot">Relay</span></div></header>
<main>
<a class="back" href="/guides">&larr; Back to guides</a>
<h1>Schedule posts to ${esc(c.label)} with LazyRelay</h1>
<p class="subtitle">${esc(c.intro)} LazyRelay's difference is Proof-of-Publish: after a post goes out, it checks ${esc(c.label)} again to confirm the post is really live.</p>

<h2>What you can post to ${esc(c.label)}</h2>
<ul>
${li(c.post(r))}
</ul>
<p class="note">LazyRelay checks file size and format before a post is scheduled and tells you which limit was hit. For the full comparison of what each platform supports, see <a href="/platform-features">What Works on Which Platform</a>.</p>

<h2>How to connect ${esc(c.label)}</h2>
<ol>
${li(c.connect(r))}
</ol>

<h2>How Proof-of-Publish works on ${esc(c.label)}</h2>
<p>${esc(c.pop)}</p>
<p>Want the general idea? Read <a href="/verify-post-published">Does Your Post Actually Publish?</a></p>

<h2>Limits and things to know</h2>
<ul>
${li(c.caveats)}
</ul>

<div class="cta-box">
  <p style="margin-top:0;"><strong>Schedule to ${esc(c.label)} and know it actually went live.</strong></p>
  <a class="button" href="/pricing">See plans and get started free</a>
</div>

<h2>Frequently asked questions</h2>
${faq.map(([q, a]) => `<div class="faq-item">\n  <h3>${esc(q)}</h3>\n  <p>${esc(a)}</p>\n</div>`).join("\n")}

${sources}
<p class="note">Schedule to other platforms: ${others}</p>

</main>
<footer>
  <p><a href="/">Home</a> &middot; <a href="/guides">Guides</a> &middot; <a href="/pricing">Pricing</a> &middot; <a href="/platform-features">What Works on Which Platform</a> &middot; <a href="/verify-post-published">Does Your Post Actually Publish?</a> &middot; <a href="/docs">Docs</a> &middot; <a href="/terms">Terms of Service</a> &middot; <a href="/privacy">Privacy Policy</a> &middot; <a href="/refunds">Refund Policy</a></p>
  <p class="note">&copy; 2026 LazyRelay. All rights reserved.</p>
</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// 5. Run
// ---------------------------------------------------------------------------------------------
const rules = loadRules();
const byPlatform = Object.fromEntries(rules.map((r) => [r.platform, r]));

if (process.argv.includes("--print-sigs")) {
  const out = {};
  for (const s of ORDER) out[s] = sig(byPlatform[s]);
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const checked = rulesCheckedDate();
// Slack was checked against its docs on 2026-10-01 (see platformRules.ts), a day after the other platforms.
const CHECKED_OVERRIDE = { slack: "2026-10-01" };
const manifest = [];
const problems = [];

for (const slug of ORDER) {
  const c = COPY[slug];
  const r = byPlatform[slug];
  if (!r) throw new Error(`platformRules.ts has no entry for ${slug}`);
  if (Object.keys(COPY_SIGS).length && COPY_SIGS[slug] !== sig(r)) {
    console.warn(`WARNING: the rules for ${slug} changed since its copy was written. Re-read COPY.${slug} against platformRules.ts, then run with --print-sigs and update COPY_SIGS.`);
  }
  if (c.desc.length >= 160) problems.push(`${slug}: meta description is ${c.desc.length} characters, must be under 160`);
  const html = renderPage(c, r, ORDER, CHECKED_OVERRIDE[slug] ?? checked);
  if (/[–—]/.test(html)) problems.push(`${slug}: output contains an em dash or en dash`);
  const dir = join(PUBLIC_DIR, `schedule-to-${c.slug}`);
  manifest.push({
    slug: c.slug,
    url: `${SITE}/schedule-to-${c.slug}/`,
    title: `Schedule Posts to ${c.label} with LazyRelay | LazyRelay`,
    description: c.desc,
    _dir: dir,
    _html: html,
  });
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

for (const m of manifest) {
  mkdirSync(m._dir, { recursive: true });
  writeFileSync(join(m._dir, "index.html"), m._html);
}
const clean = manifest.map(({ _dir, _html, ...rest }) => rest);
const manifestJson = JSON.stringify(clean, null, 2) + "\n";
if (/[–—]/.test(manifestJson)) {
  console.error("manifest contains an em dash or en dash");
  process.exit(1);
}
writeFileSync(join(HERE, "channel-pages-manifest.json"), manifestJson);
console.log(`Wrote ${manifest.length} pages and channel-pages-manifest.json`);
