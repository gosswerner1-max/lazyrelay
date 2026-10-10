import { platformLabel } from "./tokenHealth.js";
import { X_NOT_BYOK_MESSAGE } from "./platforms/xByok.js";

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

// The Pinterest wording is the set of rules Werner approved (the account and
// domain are checked closely, the block is Pinterest's decision, appeal through
// Pinterest, start slowly, never work around the block). Same text the
// dashboard uses for rows recorded before the server wrote its own reasons
// (frontend/src/lib/errorMessages.ts): change both together.
export const PINTEREST_BLOCKED_LINK_MESSAGE =
  "Pinterest blocked the link in this pin. This is a Pinterest decision about the website address, not something LazyRelay can change. You can ask Pinterest to review it in Pinterest's Help Center (Appeals, then Pinterest blocked my site). New websites are checked more closely, so start slowly and vary your captions.";
export const PINTEREST_DAILY_LIMIT_MESSAGE =
  "Pinterest limits how many pins one account can post in a day. Try again tomorrow, or spread your pins across more days.";

// What Pinterest's own rejection says. Shared with the blocked-link breaker
// and the scheduling-time warning so all three recognize the same failures.
export const PINTEREST_BLOCKED_LINK_PATTERN = /blocked this link|may lead to spam/i;

export type PostErrorKind ="retry" | "fatal" | "reconnect" | "ours";

export interface ClassifiedPostError {
  kind: PostErrorKind;
  message: string;
  /** X bring-your-own-key only: what this failure says about the customer’s keys, for social_accounts.byok_status. */
  byokStatus?: "invalid" | "out_of_credit";
  /** Retry-class only: the earliest time (ms since epoch) the platform will accept another try, when it said so. */
  retryNotBefore?: number;
}

interface Rule {
  platform?: string | string[];
  /** Platform keys this rule must never apply to. */
  except?: string[];
  /** X bring-your-own-key: sets byok_status on the account. */
  byokStatus?: "invalid" | "out_of_credit";
  test: RegExp;
  kind: PostErrorKind;
  /** `raw` is the adapter's own text, for the few rules that quote part of it (Whop's validation message). */
  message: (p: string, raw: string) => string;
}

// ---- X with the customer’s own keys (platform key "x_byok", see scheduler.ts classifierPlatform). The adapter reports
// one compact line (x_api_error status=... title=... detail=...) built from X’s own error fields; these rules read it.
// They sit above everything else so the generic "ours" rule below can never blame LazyRelay for a customer’s keys,
// and nothing here changes how any other platform is classified. Order matters: credits first (X names them under
// 402, 403 and 429), then app permissions, then dead keys, then the plain rate limit.
export const X_BYOK_CREDIT_MESSAGE =
  "Your X developer account has no credits or hit its spending limit. Add credits in the X Developer Console and schedule the post again.";
export const X_BYOK_PERMISSION_MESSAGE = "Your X app needs Read and Write permission. Regenerate the Access Token after changing it.";
export const X_BYOK_INVALID_KEYS_MESSAGE = "X no longer accepts your keys. Open Social Platforms and update them.";

const X_BYOK_RULES: Rule[] = [
  {
    platform: ["x", "x_byok"],
    test: /x_byok_bundle_invalid/i,
    kind: "reconnect",
    byokStatus: "invalid",
    message: () => X_NOT_BYOK_MESSAGE,
  },
  {
    platform: "x_byok",
    test: /status=402|\bcredits?\b|creditsdepleted|usage-capped|spending[ -]?limit|insufficient funds/i,
    kind: "fatal",
    byokStatus: "out_of_credit",
    message: () => X_BYOK_CREDIT_MESSAGE,
  },
  {
    platform: "x_byok",
    test: /client-forbidden|oauth1[- ]?(app[- ])?permissions|app permissions|read[- ]only|write permission|cannot perform write|code 261\b/i,
    kind: "fatal",
    message: () => X_BYOK_PERMISSION_MESSAGE,
  },
  {
    platform: "x_byok",
    test: /status=401|code (32|89|135|215)\b|invalid or expired token|could not authenticate|invalid[ _]signature|bad authentication|token (has been )?revoked|app (has been )?(revoked|suspended)|suspended/i,
    kind: "reconnect",
    byokStatus: "invalid",
    message: () => X_BYOK_INVALID_KEYS_MESSAGE,
  },
  {
    platform: "x_byok",
    test: /status=429|rate[ -]?limit|too many requests/i,
    kind: "retry",
    message: (p) => `${p} is limiting requests right now. LazyRelay will try again automatically.`,
  },
];

const RULES: Rule[] = [
  ...X_BYOK_RULES,
  // ---- Our side: never the customer's fault ----
  // (Not for X: LazyRelay has no X app, every X credential is the customer's own, so an app-secret error there is theirs.)
  {
    except: ["x", "x_byok"],
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
    test: PINTEREST_BLOCKED_LINK_PATTERN,
    kind: "fatal",
    message: () => PINTEREST_BLOCKED_LINK_MESSAGE,
  },
  {
    // Must sit before the generic rate-limit rule below: the wording contains
    // "24 hours" and "posts".
    platform: "pinterest",
    test: /maximum number of[\s\S]{0,60}posts?[\s\S]{0,60}24 hours/i,
    kind: "fatal",
    message: () => PINTEREST_DAILY_LIMIT_MESSAGE,
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

  // Slack answers failures as HTTP 200 {ok:false, error:"<code>"} and the adapter passes the code through. The
  // Slack rules sit above the generic ones because the codes (invalid_auth, ratelimited, msg_too_long) use
  // underscores the generic wording tests would not match.
  {
    platform: "slack",
    test: /invalid_auth|not_authed|token_revoked|token_expired|account_inactive|org_login_required|team_access_not_granted|invalid_refresh_token/i,
    kind: "reconnect",
    message: (p) => `Your ${p} connection has expired or was revoked, so LazyRelay can't post to it. Reconnect it in Social Platforms, then schedule the post again.`,
  },
  {
    platform: "slack",
    test: /missing_scope|no_permission|not_allowed_token_type/i,
    kind: "reconnect",
    message: (p) => `LazyRelay doesn't have the permissions it needs in this ${p} workspace. Reconnect it in Social Platforms and approve every permission LazyRelay asks for.`,
  },
  {
    platform: "slack",
    test: /channel_not_found|not_in_channel/i,
    kind: "fatal",
    message: () =>
      "LazyRelay can't post to that Slack channel. If it is a private channel, invite the LazyRelay app to it first (in the channel, type /invite and pick LazyRelay). If the channel was deleted, reconnect Slack and pick another one.",
  },
  {
    platform: "slack",
    test: /is_archived/i,
    kind: "fatal",
    message: () => "That Slack channel has been archived, so nothing can be posted to it. Reconnect Slack and pick a different channel.",
  },
  {
    platform: "slack",
    test: /restricted_action/i,
    kind: "fatal",
    message: () => "Your Slack workspace settings stop LazyRelay from posting in that channel (some workspaces limit who can post, for example in #general). Ask a Slack admin to allow it, or reconnect Slack and pick another channel.",
  },
  {
    platform: "slack",
    test: /msg_too_long|no_text/i,
    kind: "fatal",
    message: () => "Slack could not take this post: it is empty or longer than the 4,000 characters LazyRelay allows for Slack. Edit the text and schedule it again.",
  },
  {
    platform: "slack",
    test: /message_not_found/i,
    kind: "retry",
    message: (p) => `The post was sent to ${p} but it hasn't confirmed it yet. LazyRelay is re-checking it and will not post it twice.`,
  },
  {
    platform: "slack",
    test: /ratelimited/i,
    kind: "retry",
    message: (p) => `${p} is limiting requests right now. LazyRelay will try again automatically.`,
  },
  {
    platform: "slack",
    test: /service_unavailable|internal_error|fatal_error|request_timeout|accesslimited/i,
    kind: "retry",
    message: (p) => `${p} had a temporary problem. LazyRelay will try again automatically.`,
  },

  // Whop: the adapter reports short codes (whop_*) built from the HTTP status, never Whop's free text, except for 400 and
  // 422 where Whop's own (scrubbed, 300 character) message is quoted so the customer can see what Whop wants. These sit
  // above the generic rules for the same reason as Slack's. A 404 while CONFIRMING a post is a different code
  // (whop_unconfirmed): the post was just created, so it is re-checked, never a reconnect request and never a second post.
  {
    platform: "whop",
    test: /whop_(unauthorized|forbidden|not_found)/i,
    kind: "reconnect",
    message: () =>
      "Whop says LazyRelay no longer has permission in this community (the app was removed, its permissions changed, or the forum is gone). Reinstall the LazyRelay app from the Whop connect screen, then reconnect Whop in Social Platforms and schedule the post again.",
  },
  {
    platform: "whop",
    test: /whop_unconfirmed/i,
    kind: "retry",
    message: (p) => `The post was sent to ${p} but it hasn't confirmed it yet. LazyRelay is re-checking it and will not post it twice.`,
  },
  {
    platform: "whop",
    test: /whop_rate_limited/i,
    kind: "retry",
    message: (p) => `${p} is limiting requests right now. LazyRelay will try again automatically.`,
  },
  {
    platform: "whop",
    test: /whop_(server_error|conflict|unreachable)|could not reach whop|whop_http_/i,
    kind: "retry",
    message: (p) => `${p} had a temporary problem. LazyRelay will try again automatically.`,
  },
  {
    platform: "whop",
    test: /whop_validation/i,
    kind: "fatal",
    message: (_p, raw) => {
      const detail = /whop_validation[^:]*:s*(.+)$/i.exec(raw)?.[1]?.trim();
      return `Whop would not accept this post${detail ? `: ${detail}` : ""}. If Whop is asking you to verify something, do that in Whop first, then schedule the post again.`;
    },
  },
  {
    platform: "whop",
    test: /whop_too_long|whop_empty|whop_text_only|whop_bad_request/i,
    kind: "fatal",
    message: () => "Whop posts through LazyRelay are plain Markdown text, between 1 and 4,000 characters, with no image or video. Edit the post and schedule it again.",
  },

  // Nostr: the adapter reports short codes only (nostr_*), never text written by a relay or a signer. Placed above the
  // generic rules, whose wording tests ("timeout", "duplicate", "rate limit") would otherwise misread these codes.
  {
    platform: "nostr",
    test: /nostr_signer_(refused|revoked|auth_url)|nostr_bad_connection/i,
    kind: "reconnect",
    message: (p) =>
      `Your ${p} signer app stopped accepting LazyRelay (it refused the request, asked for extra approval, or the connection was removed). Open the signer app and allow LazyRelay to sign notes without asking each time, then reconnect it in Social Platforms and schedule the post again.`,
  },
  {
    platform: "nostr",
    test: /nostr_signer_(unreachable|timeout)/i,
    kind: "retry",
    message: () =>
      "LazyRelay could not reach your Nostr signer app, so it could not sign this post. The signer app has to be online (and approved to sign for scheduled posts) at the moment a post goes out. LazyRelay will try again automatically.",
  },
  {
    platform: "nostr",
    test: /nostr_signer_(bad_event|protocol)/i,
    kind: "fatal",
    message: () =>
      "Your Nostr signer returned a note that was not the one LazyRelay asked it to sign, so nothing was posted. Check your signer app, reconnect it in Social Platforms if it keeps happening, then schedule the post again.",
  },
  {
    platform: "nostr",
    test: /nostr_relay_rejected: ?(rate-limited|invalid-time)|nostr_relay_timeout|nostr_relays_unreachable|nostr_unexpected_error/i,
    kind: "retry",
    message: () => "None of your Nostr relays took the note just now (they were busy, slow or unreachable). LazyRelay will try again automatically.",
  },
  {
    platform: "nostr",
    test: /nostr_relay_rejected: ?(restricted|blocked|pow|invalid|other)/i,
    kind: "fatal",
    message: () =>
      "Your Nostr relays refused the note (they may require payment or sign-in, block the account, or demand proof of work). LazyRelay cannot get around that. Change your relays in your Nostr profile (your NIP-65 relay list), then schedule the post again.",
  },
  {
    platform: "nostr",
    test: /nostr_unconfirmed/i,
    kind: "retry",
    message: () => "The note was sent to your Nostr relays but none of them has shown it back yet. LazyRelay is re-checking it and will not post it twice.",
  },
  {
    platform: "nostr",
    test: /nostr_too_long|nostr_empty|nostr_text_only/i,
    kind: "fatal",
    message: () => "Nostr posts through LazyRelay are plain text only, between 1 and 4,000 characters, with no image or video. Edit the post and schedule it again.",
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
    if (rule.except?.includes(platform)) continue;
    if (rule.platform && !(Array.isArray(rule.platform) ? rule.platform.includes(platform) : rule.platform === platform)) continue;
    if (rule.test.test(raw)) {
      const out: ClassifiedPostError = { kind: rule.kind, message: rule.message(label, raw) };
      if (rule.byokStatus) out.byokStatus = rule.byokStatus;
      if (platform === "x_byok" && rule.kind === "retry") {
        // X says when its rate-limit window resets (x-rate-limit-reset, surfaced by the adapter as reset=<epoch seconds>).
        const reset = /\breset=(\d{9,11})\b/.exec(raw);
        if (reset) out.retryNotBefore = Number(reset[1]) * 1000;
      }
      return out;
    }
  }
  // Unknown: exactly today's behavior (retry, raw text).
  return { kind: "retry", message: raw };
}
