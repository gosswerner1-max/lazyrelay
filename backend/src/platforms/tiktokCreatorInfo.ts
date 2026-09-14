// TikTok Content Sharing Guidelines, "Required UX Implementation" point 1:
// the posting app must show the creator's nickname, stop a publishing attempt
// when TikTok says the creator can't make more posts right now, and check the
// video's length against max_video_post_duration_sec. This turns TikTok's
// creator_info/query reply into exactly those values. Pure (no fetch) so it
// can be unit-tested against TikTok's documented responses.
//
// Source: developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
// (read 2026-09-14). The three "can't post" codes arrive as HTTP 200 with an
// error code, not as an HTTP error status.

export interface TiktokCreatorInfoResult {
  nickname: string | null;
  maxVideoDurationSec: number | null;
  canPost: boolean;
  cantPostReason: string | null;
  privacyLevelOptions: string[];
}

export const TIKTOK_CANT_POST_MESSAGES: Record<string, string> = {
  spam_risk_too_many_posts: "TikTok's daily posting limit for this account has been reached. Please try again later.",
  spam_risk_user_banned_from_posting:
    "TikTok isn't allowing this account to make new posts right now. Please try again later.",
  reached_active_user_cap: "TikTok's daily limit for LazyRelay has been reached. Please try again later.",
};

interface CreatorInfoEnvelope {
  data?: {
    creator_nickname?: unknown;
    max_video_post_duration_sec?: unknown;
    privacy_level_options?: unknown;
  };
  error?: { code?: unknown };
}

export function parseCreatorInfo(json: unknown): TiktokCreatorInfoResult {
  const envelope = (json && typeof json === "object" ? json : {}) as CreatorInfoEnvelope;
  const code = typeof envelope.error?.code === "string" ? envelope.error.code : null;
  const cantPostReason = code !== null ? (TIKTOK_CANT_POST_MESSAGES[code] ?? null) : null;

  const data = envelope.data;
  const nickname =
    typeof data?.creator_nickname === "string" && data.creator_nickname.trim() !== "" ? data.creator_nickname : null;
  const max = data?.max_video_post_duration_sec;
  const maxVideoDurationSec = typeof max === "number" && Number.isFinite(max) && max > 0 ? max : null;
  const privacyLevelOptions = Array.isArray(data?.privacy_level_options)
    ? data.privacy_level_options.filter((o): o is string => typeof o === "string")
    : [];

  return { nickname, maxVideoDurationSec, canPost: cantPostReason === null, cantPostReason, privacyLevelOptions };
}
