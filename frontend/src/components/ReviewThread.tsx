import { useCallback, useEffect, useState } from "react";
import { api, type ScheduledPost } from "../lib/api";
import { describeComment, type ReviewComment } from "../lib/reviewLinks";

// The client conversation on a post waiting for approval, in the owner's Posts list: read what
// the client said, reply, and fix the wording right there (which puts it back for review).

interface Props {
  postId: string;
  content: string;
  changesRequested: boolean;
  onChanged: () => void | Promise<void>;
  /** Called at once with the saved post, so the list can show the new wording before the full refresh finishes. */
  onUpdated?: (post: ScheduledPost) => void;
  onError: (message: string | null) => void;
}

export function ReviewThread({ postId, content, changesRequested, onChanged, onUpdated, onError }: Props) {
  const [open, setOpen] = useState(changesRequested);
  const [comments, setComments] = useState<ReviewComment[] | null>(null);
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setComments((await api.listReviewComments(postId)).comments);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [postId, onError]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await action();
      await load();
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      {changesRequested && <p className="section-note"><strong>Your client asked for changes.</strong></p>}
      <button type="button" className="btn-outline" onClick={() => setOpen(!open)}>
        {open ? "Hide client feedback" : "Client feedback"}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          {comments && comments.length === 0 && <p className="section-note">No feedback from your client yet.</p>}
          {comments?.map((c, i) => (
            <div key={c.id ?? i} className="section-note" style={{ borderLeft: "3px solid var(--border, #444)", paddingLeft: 8 }}>
              <strong>{describeComment(c)}</strong> <span>{new Date(c.createdAt).toLocaleString()}</span>
              {c.body && <div style={{ whiteSpace: "pre-wrap" }}>{c.body}</div>}
            </div>
          ))}

          {editing ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || !draft.trim()}
                  onClick={() =>
                    run(async () => {
                      const saved = await api.editPostContent(postId, draft);
                      if (saved && typeof saved === "object" && "id" in saved) onUpdated?.(saved);
                      setEditing(false);
                    })
                  }
                >
                  Save the new wording
                </button>
                <button type="button" className="btn-outline" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn-outline" style={{ width: "fit-content" }} onClick={() => { setDraft(content); setEditing(true); }}>
              Change the wording
            </button>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ flex: 1 }} type="text" maxLength={1000} placeholder="Reply to your client" value={reply} onChange={(e) => setReply(e.target.value)} />
            <button
              type="button"
              className="btn-outline"
              disabled={busy || !reply.trim()}
              onClick={() =>
                run(async () => {
                  await api.addReviewComment(postId, reply);
                  setReply("");
                })
              }
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
