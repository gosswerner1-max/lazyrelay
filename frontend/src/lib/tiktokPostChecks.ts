// TikTok Content Sharing Guidelines, "Required UX Implementation" points 1 and 5:
// check the video's length against the longest video TikTok lets this creator
// post (max_video_post_duration_sec, from GET /social-accounts/:id/tiktok-creator-info),
// and tell the user a posted video can take a few minutes to appear.

export interface TiktokCreatorInfo {
  nickname: string | null;
  maxVideoDurationSec: number | null;
  canPost: boolean;
  cantPostReason: string | null;
}

export const TIKTOK_PROCESSING_NOTICE =
  "After you post, it can take a few minutes for your video to process and appear on your TikTok profile.";

/** True only when both the video's length and TikTok's limit are known and
 *  the video is longer. Unknown values never block: TikTok still enforces its
 *  own limit. Fractions of a second are ignored (a "5:00" export is often
 *  300.03s long), so only a whole extra second counts as too long. */
export function isVideoTooLongForTiktok(durationSec: number | null, maxSec: number | null): boolean {
  if (durationSec == null || maxSec == null) return false;
  if (!Number.isFinite(durationSec) || !Number.isFinite(maxSec) || maxSec <= 0) return false;
  return Math.floor(durationSec) > maxSec;
}

/** Whole seconds as m:ss, e.g. 605 -> "10:05". */
export function formatDuration(totalSec: number): string {
  const seconds = Math.max(0, Math.floor(totalSec));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function tiktokVideoTooLongMessage(durationSec: number, maxSec: number): string {
  return `This video is ${formatDuration(durationSec)} long, but TikTok lets this account post videos up to ${formatDuration(maxSec)}. Choose a shorter video.`;
}
