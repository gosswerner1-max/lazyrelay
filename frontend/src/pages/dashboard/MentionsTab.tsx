// The "Mentions" tab — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). State and handlers still
// live in one place (useDashboardState.tsx, called once by Dashboard.tsx)
// and reach this file through DashboardContext.

import { type MentionPost } from "../../lib/api";
import { PlatformIcon } from "../../components/PlatformIcon";
import { Spinner } from "../../components/Spinner";
import { accountMatchesBrand, localDateKey } from "./dashboardHelpers";
import { BrandFilterSelect, TriageBadge } from "./dashboardComponents";
import { useDashboard } from "./DashboardContext";

// Platforms whose comments are shown in this tab: dev.to, Hashnode, Mastodon,
// Bluesky and YouTube. None of them depends on a Meta permission. Every other
// platform that can return comments (Facebook, Instagram, ...) stays out until
// it is approved and checked, and shows a "Coming soon" row instead, so the tab
// never advertises something that would silently fail.
const MENTIONS_LIVE_PLATFORMS = new Set(["devto", "hashnode", "mastodon", "bluesky", "youtube"]);

// Reply-from-here is parked (Werner, 2026-10-07): comments are read-only in
// this tab for every platform until the draft-first reply loop is built.
const REPLIES_LIVE = false;

const PLATFORM_LABELS: Record<string, string> = {
  devto: "dev.to",
  hashnode: "Hashnode",
  facebook: "Facebook",
  instagram: "Instagram",
  mastodon: "Mastodon",
  bluesky: "Bluesky",
  youtube: "YouTube",
  lemmy: "Lemmy",
  telegram: "Telegram",
  wordpress: "WordPress",
  discord: "Discord",
};

export function MentionsTab() {
  const {
    accounts,
    brandFilter,
    setBrandFilter,
    mentions,
    mentionsLoading,
    mentionsAttentionOnly,
    setMentionsAttentionOnly,
    replyDrafts,
    setReplyDrafts,
    replyingCommentId,
    replySentCommentId,
    handleReplyToComment,
  } = useDashboard();

  return (
    <section>
      <h2>Mentions &amp; comments</h2>
      <p className="muted">
        Comments on your recent posts, pulled directly from each platform. Dev.to, Hashnode, Mastodon, Bluesky
        and YouTube comments show here today (read-only: reply on the platform itself). Facebook and Instagram
        are coming soon. Every other platform's comments still live on the platform itself.
      </p>
      {mentionsLoading && <Spinner />}
      {!mentionsLoading && mentions && mentions.length === 0 && <p className="empty">No recent posted content yet.</p>}
      {!mentionsLoading && mentions && mentions.length > 0 && (() => {
        const liveMentions = mentions.filter((p) => MENTIONS_LIVE_PLATFORMS.has(p.platform));
        // One line per platform that has posts but is not live yet (never its comments).
        const comingSoonCounts = new Map<string, number>();
        for (const p of mentions) {
          if (!MENTIONS_LIVE_PLATFORMS.has(p.platform)) comingSoonCounts.set(p.platform, (comingSoonCounts.get(p.platform) ?? 0) + 1);
        }
        const attentionCount = liveMentions.reduce((sum, p) => sum + p.comments.filter((c) => c.triage?.needsAttention).length, 0);
        const brandFilteredMentions = liveMentions.filter((p) => accountMatchesBrand(accounts.find((a) => a.id === p.socialAccountId), brandFilter));
        const visiblePosts = mentionsAttentionOnly
          ? brandFilteredMentions.map((p) => ({ ...p, comments: p.comments.filter((c) => c.triage?.needsAttention) })).filter((p) => p.comments.length > 0)
          : brandFilteredMentions;

        // Same date-grouped pattern as the Posts tab's History list
        // (2026-08-07, Werner: "must do the same here") — a flat list
        // gets unmanageable the same way once there are more than a
        // handful of posts.
        const groups = new Map<string, MentionPost[]>();
        for (const post of visiblePosts) {
          const key = localDateKey(post.scheduledFor);
          (groups.get(key) ?? groups.set(key, []).get(key)!).push(post);
        }
        const sortedKeys = [...groups.keys()].sort((a, b) => b.localeCompare(a));
        return (
        <>
          <BrandFilterSelect accounts={accounts} value={brandFilter} onChange={setBrandFilter} />
          <label className="triage-filter">
            <input type="checkbox" checked={mentionsAttentionOnly} onChange={(e) => setMentionsAttentionOnly(e.target.checked)} />
            {attentionCount > 0 ? `Show only the ${attentionCount} that need attention` : "Show only comments that need attention"}
          </label>
          {visiblePosts.length === 0 && <p className="empty">Nothing to show for this filter right now.</p>}
          {sortedKeys.map((key, i) => {
          const posts = groups.get(key)!;
          const label = new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          });
          return (
            <details key={key} className="post-date-group" open={i === 0}>
              <summary>
                {label}
                <span className="post-date-group-count">
                  {posts.length} post{posts.length === 1 ? "" : "s"}
                </span>
              </summary>
              <ul className="mentions-list">
                {posts.map((post) => (
                  <li key={post.postId} className="mentions-post">
                    <div className="post-platform">
                      <PlatformIcon platform={post.platform} size={14} />
                      {post.platform}
                      {post.platformPostUrl && (
                        <a href={post.platformPostUrl} target="_blank" rel="noopener noreferrer" className="mentions-view-link">
                          View post
                        </a>
                      )}
                    </div>
                    <div className="post-content">{post.content}</div>
                    {!post.supported && <p className="mentions-unsupported">Comments aren't available for this platform yet.</p>}
                    {post.supported && post.errorMessage && <p className="mentions-unsupported">{post.errorMessage}</p>}
                    {post.supported && post.comments.length === 0 && !post.errorMessage && (
                      <p className="mentions-empty">No comments yet.</p>
                    )}
                    {post.comments.length > 0 && (
                      <ul className="mentions-comment-list">
                        {post.comments.map((c) => (
                          <li key={c.id}>
                            <span className="mentions-comment-author">{c.author}</span>
                            <span className="mentions-comment-text">{c.text}</span>
                            <TriageBadge triage={c.triage} />
                            {REPLIES_LIVE && post.canReply && (
                              replySentCommentId === c.id ? (
                                <span className="mentions-reply-sent">Reply sent</span>
                              ) : (
                                <form
                                  className="mentions-reply-form"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    handleReplyToComment(post.postId, c.id);
                                  }}
                                >
                                  <input
                                    type="text"
                                    placeholder="Write a reply..."
                                    value={replyDrafts[c.id] ?? ""}
                                    onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                                    maxLength={2000}
                                  />
                                  <button type="submit" disabled={replyingCommentId === c.id || !replyDrafts[c.id]?.trim()}>
                                    {replyingCommentId === c.id ? "Sending..." : "Reply"}
                                  </button>
                                </form>
                              )
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          );
          })}
          {comingSoonCounts.size > 0 && (
            <ul className="mentions-list">
              {[...comingSoonCounts.entries()].map(([platform, count]) => (
                <li key={platform} className="mentions-post">
                  <div className="post-platform">
                    <PlatformIcon platform={platform} size={14} />
                    {PLATFORM_LABELS[platform] ?? platform}
                    <span className="coming-soon-badge">Coming soon</span>
                  </div>
                  <p className="mentions-unsupported">
                    Comments on your {count} recent {PLATFORM_LABELS[platform] ?? platform} post{count === 1 ? "" : "s"} will
                    show here once {PLATFORM_LABELS[platform] ?? platform} comments are switched on.
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
        );
      })()}
    </section>
  );
}
