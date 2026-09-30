import { platformLabel } from "./tokenHealth.js";

// Turns a raw platform error into (a) what the scheduler should DO about it
// and (b) a plain-language reason the customer can act on. Written from the
// errors LazyRelay has really hit (post_results, 2026-09-30) plus codes the
// platforms document publicly (Meta Graph error handling, TikTok Content
// Posting API direct-post errors). Rules run in order, first match wins.
//
// kind:
//   retry      transient (rate limit, media still processing, read-after-write
//              lag, network): keep the existing backoff retries.
//   fatal      retrying cannot help (blocked link, duplicate, bad format, a
//              daily cap): fail now, tell the customer why. Never counts
//              toward the platform circuit breaker: it says nothing about the
//              platform's health.
//   reconnect  the saved login is dead: fail now and flag the account so the
//              customer is told to reconnect.
//   ours       the fault is LazyRelay's (our app credentials or app status),
//              never the customer's: retry, and never blame or flag them.
// Unknown errors keep today's behavior exactly: retry, raw text shown.

export type PostErrorKind = "retry" | "fatal" | "reconnect" | "ours";

export interface ClassifiedPostError {
  kind: PostErrorKind;
  message: string;
}

interface Rule {
  platform?: string;
  test: RegExp;
  kind: PostErrorKind;
  message: (p: string) => string;
}

const RULES: Rule[] = [
  // ---- Our side: never the customer's fault ----
  {
    test: /invalid_client|client (key|secret) (or (key|secret) )?(is |are )?(incorrect|invalid)|app secret|unaudited_client_can_only_post_to_private_accounts|url_ownership_unverified|reached_active_user_cap/i,
    kind: "ours",
    message: (p) => `LazyRelay hit a temporary problem connecting to ${p}. We have been alerted and will try again automatically. You don't need to do anything.`,
  },

  // ---- Read-after-write lag: the post was sent, the platform just hasn't caught up.
  // Must come BEFORE the permission rules: Meta's wording for this also says
  // 'missing permissions'. Confirmed 2026-09-24: those posts were live all along. ----
  {
    test: /requested resource does not exist|object with id .* does not exist|unsupported get request/i,
    kind: "retry",
    message: (p) => `The post was sent to ${p} but it hasn't confirmed it yet. LazyRelay is re-checking it and will not post it twice.`,
  },

  // ---- Platform-specific, seen in real failures ----
  {
    platform: "pinterest",
    test: /blocked this link|may lead to spam/i,
    kind: "fatal",
    message: () => "Pinterest blocked the link in this post because its spam filter flagged it. Retrying won't help. Remove the link or use a different destination link, then schedule it again.",
  },
  {
    platform: "facebook",
    test: /confirm your identity before you can publish|user checkpointed|"error_subcode":\s*459/i,
    kind: "fatal",
    message: () => "Facebook needs you to confirm your identity before this Page can publish. Open the Facebook app on your phone, follow the prompts, then schedule the post again.",
  },
  {
    platform: "tiktok",
    test: /spam_risk_too_many_posts/i,
    kind: "fatal",
    message: () => "TikTok's daily posting limit for this account has been reached. Try again tomorrow.",
  },
  {
    platform: "tiktok",
    test: /spam_risk_user_banned_from_posting/i,
    kind: "fatal",
    message: () => "TikTok has blocked this account from creating new posts. This is TikTok's decision and can only be resolved with TikTok.",
  },
  {
    platform: "tiktok",
    test: /privacy_level_option_mismatch/i,
    kind: "fatal",
    message: () => "The privacy setting chosen for this post isn't available for this TikTok account. Pick a different privacy option and schedule it again.",
  },
  {
    platform: "tiktok",
    test: /content-sharing-guidelines|integration guidelines/i,
    kind: "fatal",
    message: () => "TikTok declined this post. TikTok doesn't say why, so check the video and caption against TikTok's content sharing guidelines, then try again.",
  },

  // ---- The saved login is dead: only the customer can fix it ----
  {
    test: /access_token_invalid|scope_not_authorized|refresh token is invalid|invalid_grant|token has expired|expiredtoken|invalidtoken|error validating access token|session has been invalidated|unable to authorize|"code":\s*(190|102)\b|\(#(190|102)\)|password changed/i,
    kind: "reconnect",
    message: (p) => `Your ${p} connection has expired or was revoked, so LazyRelay can't post to it. Reconnect it in Social Platforms, then schedule the post again.`,
  },
  {
    test: /"code":\s*(10|2\d\d)\b|\(#(10|2\d\d)\)|permission(s)? (denied|missing|not granted)|missing permission/i,
    kind: "reconnect",
    message: (p) => `LazyRelay doesn't have the permissions it needs on this ${p} account. Reconnect it in Social Platforms and approve every permission LazyRelay asks for.`,
  },

  // ---- Retrying cannot help ----
  {
    test: /"code":\s*368\b|\(#368\)|temporarily blocked for policy/i,
    kind: "fatal",
    message: (p) => `${p} has temporarily blocked publishing from this account for a policy reason. Wait a while, then try again.`,
  },
  {
    test: /duplicate|already (been )?(posted|shared|published)|same (text|content|post)/i,
    kind: "fatal",
    message: (p) => `${p} rejected this post as a duplicate of a recent one. Change the wording a little and schedule it again.`,
  },
  {
    test: /too long|exceeds? (the )?(maximum|max|character|length)|character limit|maximum (allowed )?length/i,
    kind: "fatal",
    message: (p) => `The text is longer than ${p} allows. Shorten it and schedule the post again.`,
  },
  {
    test: /unsupported (media|video|image|file|format)|invalid (aspect ratio|image|video|media)|aspect ratio|file format|file_format|duration_check|picture_size|frame_rate/i,
    kind: "fatal",
    message: (p) => `${p} rejected the image or video (format, size, length or shape). Check ${p}'s media requirements, then upload a corrected file.`,
  },

  // ---- Transient: keep retrying ----
  {
    test: /not ready yet|still processing|not finished processing|processing did not finish|status: (processing|uploading)|in progress/i,
    kind: "retry",
    message: (p) => `${p} is still processing the media. LazyRelay will check again shortly.`,
  },
  {
    test: /rate limit|too many (requests|calls)|\b429\b|"code":\s*(4|17|32|341|613)\b|\(#(4|17|32|341|613)\)|rate_limit_exceeded|quota/i,
    kind: "retry",
    message: (p) => `${p} is limiting requests right now. LazyRelay will try again automatically.`,
  },
  {
    test: /timeout|timed out|econnreset|etimedout|eai_again|fetch failed|socket hang up|service unavailable|\b50[234]\b|"code":\s*(1|2)\b|temporar|try again later/i,
    kind: "retry",
    message: (p) => `${p} had a temporary problem. LazyRelay will try again automatically.`,
  },
];

/** Classifies a raw error. `raw` is stored separately for support; only
 *  `message` is shown to the customer. */
export function classifyPostError(platform: string, raw: string): ClassifiedPostError {
  const label = platformLabel(platform);
  for (const rule of RULES) {
    if (rule.platform && rule.platform !== platform) continue;
    if (rule.test.test(raw)) return { kind: rule.kind, message: rule.message(label) };
  }
  // Unknown: exactly today's behavior (retry, raw text).
  return { kind: "retry", message: raw };
}
