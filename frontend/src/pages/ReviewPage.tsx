import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { describeComment, REVIEWER_NAME_KEY, type PublicReview, type PublicReviewPost } from "../lib/reviewLinks";
import { describeOptions, type PostOptions } from "../lib/postOptions";
import { isVideoFile } from "../lib/carousel";
import "./ReviewPage.css";
import { Spinner } from "../components/Spinner";
import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";

// The page a CLIENT opens from a review link: no login. It shows the posts waiting for their
// approval and lets them approve, ask for changes, or comment. The link is the only credential,
// so the page keeps it out of search engines and out of the Referer header sent to media hosts.

function useReviewPageHygiene() {
  useEffect(() => {
    const added: HTMLMetaElement[] = [];
    for (const [name, content] of [
      ["robots", "noindex, nofollow"],
      ["referrer", "no-referrer"],
    ]) {
      const meta = document.createElement("meta");
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
      added.push(meta);
    }
    return () => added.forEach((m) => m.remove());
  }, []);
}

function readName(): string {
  try {
    return localStorage.getItem(REVIEWER_NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

const STATE_LABEL = { waiting: "Waiting for your approval", changes_requested: "You asked for changes", approved: "Approved" } as const;

export function ReviewPage({ token }: { token: string }) {
  useReviewPageHygiene();
  const [review, setReview] = useState<PublicReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState(readName);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReview(await api.getPublicReview(token));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  function rememberName(v: string) {
    setName(v);
    try {
      localStorage.setItem(REVIEWER_NAME_KEY, v);
    } catch {
      // A blocked storage just means we ask again next time.
    }
  }

  if (loading) {
    return (
      <div className="bio-page-shell bio-page-loading">
        <Spinner />
      </div>
    );
  }
  if (error || !review) {
    return (
      <div className="bio-page-shell bio-page-notfound">
        <p>{error ?? "This review link isn't valid, or it has expired."}</p>
      </div>
    );
  }

  const waiting = review.posts.filter((p) => p.state !== "approved").length;

  return (
    <div className="review-page">
      <div className="review-inner">
        <h1>{review.businessName ? `${review.businessName}: posts to review` : "Posts to review"}</h1>
        {review.label && <p className="review-note">{review.label}</p>}
        <p className="review-note">
          {waiting === 0 ? "Nothing is waiting for you right now." : `${waiting} post${waiting === 1 ? " is" : "s are"} waiting for your approval.`} Approved posts go out at their scheduled time.
        </p>

        <label className="review-name">
          Your name
          <input type="text" value={name} maxLength={60} placeholder="So the team knows who replied" onChange={(e) => rememberName(e.target.value)} />
        </label>
        {message && <p className="review-notice">{message}</p>}

        {review.posts.map((post) => (
          <ReviewPostCard
            key={post.id}
            post={post}
            token={token}
            name={name}
            onDone={async (m) => {
              setMessage(m);
              await load();
            }}
            onError={(m) => setMessage(m)}
          />
        ))}

        <p className="review-footer">
          <BrandMark size={14} /> Sent with LazyRelay. This link only shows posts waiting for approval.
        </p>
      </div>
    </div>
  );
}

function ReviewPostCard({
  post,
  token,
  name,
  onDone,
  onError,
}: {
  post: PublicReviewPost;
  token: string;
  name: string;
  onDone: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<"none" | "changes" | "comment">("none");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const images = [post.mediaUrl, ...post.mediaUrls].filter((u): u is string => !!u);
  const extras = describeOptions(post.options as PostOptions);
  const open = post.state !== "approved";

  async function run(action: () => Promise<unknown>, done: string) {
    if (!name.trim()) {
      onError("Please enter your name at the top first.");
      return;
    }
    setBusy(true);
    try {
      await action();
      setText("");
      setMode("none");
      await onDone(done);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-card">
      <div className="review-card-head">
        {post.platform && <PlatformIcon platform={post.platform} size={16} />}
        <strong>{post.accountName ?? post.platform ?? "Post"}</strong>
        {post.scheduledFor && <span className="review-when">Goes out {new Date(post.scheduledFor).toLocaleString()}</span>}
      </div>
      <p className="review-content">{post.content}</p>

      {images.length > 0 && (
        <div className="review-media">
          {images.map((u, i) =>
            isVideoFile(u) ? (
              <video key={u + i} src={u} controls />
            ) : (
              <img key={u + i} src={u} alt={`Media ${i + 1}`} referrerPolicy="no-referrer" style={images.length > 1 ? { maxWidth: 160 } : undefined} />
            ),
          )}
        </div>
      )}
      {extras.length > 0 && <p className="review-extras">{extras.join(" · ")}</p>}

      <span className={`review-state review-state-${post.state}`}>{STATE_LABEL[post.state]}</span>

      {post.comments.length > 0 && (
        <div className="review-comments">
          {post.comments.map((c, i) => (
            <div key={i} className="review-comment">
              <strong>{describeComment(c)}</strong> <span>{new Date(c.createdAt).toLocaleString()}</span>
              {c.body && <div className="review-comment-body">{c.body}</div>}
            </div>
          ))}
        </div>
      )}

      {open && (
        <>
          {mode !== "none" && (
            <div className="review-compose">
              <textarea
                value={text}
                maxLength={1000}
                placeholder={mode === "changes" ? "What should change?" : "Write a comment"}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="review-actions">
                <button
                  type="button"
                  className="review-btn-primary"
                  disabled={busy || !text.trim()}
                  onClick={() =>
                    run(
                      () => (mode === "changes" ? api.reviewRequestChanges(token, post.id, name, text) : api.reviewComment(token, post.id, name, text)),
                      mode === "changes" ? "Thank you. Your changes were sent to the team." : "Your comment was sent.",
                    )
                  }
                >
                  {mode === "changes" ? "Send change request" : "Send comment"}
                </button>
                <button type="button" className="review-btn" onClick={() => setMode("none")}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {mode === "none" && (
            <div className="review-actions">
              <button type="button" className="review-btn-primary" disabled={busy} onClick={() => run(() => api.reviewApprove(token, post.id, name), "Approved. Thank you.")}>
                {busy ? "..." : "Approve"}
              </button>
              <button type="button" className="review-btn" onClick={() => setMode("changes")}>
                Request changes
              </button>
              <button type="button" className="review-btn" onClick={() => setMode("comment")}>
                Add a comment
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
