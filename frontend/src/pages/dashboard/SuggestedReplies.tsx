// "Suggested replies": the review screen for the draft-first reply loop. LazyRelay writes a reply to a
// comment and holds it here; a person reads it, changes it if they like, then approves or discards it.
// Nothing goes out without that click.
//
// SuggestedRepliesView only draws what it is given (so it can be tested and previewed with sample data);
// SuggestedReplies loads the drafts and acts on them. The whole section is invisible while the feature is
// switched off on the server (GET /mentions/drafts answers enabled: false).

import { useCallback, useEffect, useState } from "react";
import { api, type ReplyDraft } from "../../lib/api";
import { canApprove, categoryLabel, currentText, editedTextToSend, excerpt, expiryLabel, wordingState } from "../../lib/replyDraftHelpers";
import { PlatformIcon } from "../../components/PlatformIcon";

const PLATFORM_NAMES: Record<string, string> = { bluesky: "Bluesky", mastodon: "Mastodon" };
const platformName = (platform: string) => PLATFORM_NAMES[platform] ?? (platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : "Post");

export interface SuggestedRepliesViewProps {
  drafts: ReplyDraft[];
  /** What the owner has typed so far, by draft id. */
  typed: Record<string, string>;
  /** The draft being approved or discarded right now. */
  busyId: string | null;
  errors: Record<string, string>;
  /** One short line of feedback ("Reply approved."), or null. */
  notice: string | null;
  onType: (id: string, text: string) => void;
  onApprove: (draft: ReplyDraft) => void;
  onDiscard: (draft: ReplyDraft) => void;
  now?: Date;
}

export function SuggestedRepliesView({ drafts, typed, busyId, errors, notice, onType, onApprove, onDiscard, now }: SuggestedRepliesViewProps) {
  return (
    <section className="suggested-replies" aria-labelledby="suggested-replies-heading">
      <h3 id="suggested-replies-heading" className="suggested-heading">
        Suggested replies
        {drafts.length > 0 && <span className="suggested-count">{drafts.length}</span>}
      </h3>
      <p className="muted suggested-intro">
        LazyRelay wrote a reply for each comment below. Read it, change it if you like, then approve it. Nothing goes out until you approve it.
      </p>
      {notice && (
        <p className="suggested-notice" role="status">
          {notice}
        </p>
      )}
      {drafts.length === 0 && <p className="empty">No suggested replies waiting.</p>}
      <ul className="suggested-list">
        {drafts.map((draft) => {
          const noSuggestion = draft.status === "needs_input";
          const text = currentText(draft, typed);
          const wording = wordingState(text, draft.replyLimit);
          const busy = busyId === draft.id;
          const expiry = expiryLabel(draft.expiresAt, now);
          const platform = draft.post?.platform ?? "";
          return (
            <li key={draft.id} className="suggested-card">
              <div className="post-platform">
                {platform && <PlatformIcon platform={platform} size={14} />}
                {platformName(platform)}
                {draft.post?.url && (
                  <a href={draft.post.url} target="_blank" rel="noopener noreferrer" className="mentions-view-link">
                    View post
                  </a>
                )}
              </div>
              {draft.post && <p className="suggested-post">On your post: {excerpt(draft.post.content)}</p>}

              <div className="suggested-comment">
                {draft.comment.text ? (
                  <>
                    <span className="mentions-comment-author">{draft.comment.author}</span>
                    <span className="mentions-comment-text">{draft.comment.text}</span>
                    <span className="suggested-kind">{categoryLabel(draft.triageCategory)}</span>
                  </>
                ) : (
                  <span className="mentions-empty">This comment is no longer available.</span>
                )}
              </div>

              <label htmlFor={`suggested-${draft.id}`} className="suggested-label">
                {noSuggestion ? "Your reply" : "Suggested reply"}
              </label>
              {noSuggestion && (
                <p className="suggested-hint">LazyRelay could not suggest a reply from what it knows about your business. Please write one.</p>
              )}
              <textarea
                id={`suggested-${draft.id}`}
                className="suggested-text"
                rows={3}
                value={text}
                disabled={busy}
                placeholder={noSuggestion ? "Write your reply..." : undefined}
                onChange={(e) => onType(draft.id, e.target.value)}
              />
              <div className="suggested-meta">
                <span className={wording.over ? "suggested-chars suggested-chars-over" : "suggested-chars"} aria-live="polite">
                  {wording.count} / {wording.limit}
                  {wording.over && " (too long)"}
                </span>
                {expiry && <span className="suggested-expiry">{expiry}</span>}
              </div>

              <div className="suggested-actions">
                <button type="button" className="btn-primary" disabled={busy || !canApprove(draft, typed)} onClick={() => onApprove(draft)}>
                  {busy ? "Working..." : "Approve reply"}
                </button>
                <button type="button" className="suggested-discard" disabled={busy} onClick={() => onDiscard(draft)}>
                  Discard
                </button>
              </div>
              {errors[draft.id] && (
                <p className="suggested-error" role="alert">
                  {errors[draft.id]}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Loads the drafts when the Mentions tab opens and acts on the owner's choices. Draws nothing while the feature is off. */
export function SuggestedReplies() {
  const [enabled, setEnabled] = useState(false);
  const [drafts, setDrafts] = useState<ReplyDraft[] | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<ReplyDraft[]> => {
    try {
      const res = await api.getReplyDrafts();
      setEnabled(res.enabled);
      setDrafts(res.drafts);
      return res.drafts;
    } catch {
      // A failed load is not worth an error banner on a tab that has other content: show nothing and let the next visit retry.
      setEnabled(false);
      setDrafts([]);
      return [];
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const finish = (draft: ReplyDraft, message: string) => {
    setDrafts((prev) => (prev ?? []).filter((d) => d.id !== draft.id));
    setTyped((prev) => {
      const next = { ...prev };
      delete next[draft.id];
      return next;
    });
    setNotice(message);
  };

  // The list is refreshed after any failure. If the draft is still there the message stays on its card (the owner can fix the
  // wording and try again); if it is gone (somebody else already handled it, in another tab or a teammate) its card disappears,
  // so the message moves to the notice line instead of vanishing with it.
  const fail = async (draft: ReplyDraft, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const refreshed = await load();
    if (refreshed.some((d) => d.id === draft.id)) setErrors((prev) => ({ ...prev, [draft.id]: message }));
    else setNotice(message);
  };

  const approve = async (draft: ReplyDraft) => {
    setBusyId(draft.id);
    setNotice(null);
    setErrors((prev) => ({ ...prev, [draft.id]: "" }));
    try {
      await api.approveReplyDraft(draft.id, editedTextToSend(draft, typed));
      finish(draft, "Reply approved.");
    } catch (err) {
      await fail(draft, err);
    } finally {
      setBusyId(null);
    }
  };

  const discard = async (draft: ReplyDraft) => {
    setBusyId(draft.id);
    setNotice(null);
    setErrors((prev) => ({ ...prev, [draft.id]: "" }));
    try {
      await api.discardReplyDraft(draft.id);
      finish(draft, "Suggested reply discarded.");
    } catch (err) {
      await fail(draft, err);
    } finally {
      setBusyId(null);
    }
  };

  if (!enabled || drafts === null) return null;
  return (
    <SuggestedRepliesView
      drafts={drafts}
      typed={typed}
      busyId={busyId}
      errors={errors}
      notice={notice}
      onType={(id, text) => setTyped((prev) => ({ ...prev, [id]: text }))}
      onApprove={(d) => void approve(d)}
      onDiscard={(d) => void discard(d)}
    />
  );
}
