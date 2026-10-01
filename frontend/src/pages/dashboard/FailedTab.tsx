// The "Failed" tab: only the posts that did not go out, so a customer can see
// why, fix the text, post again, move to a new time, or delete them. Added
// 2026-10-01 at Werner's request. No backend rules were loosened: a failed
// post is never edited in place. "Post again" and "Schedule" make a fresh
// copy through the existing duplicate route (optionally with the edited
// text), and only after that succeeds is the failed original deleted, so a
// problem half way leaves the original untouched.

import { useCallback, useEffect, useState } from "react";
import { api, type ScheduledPost } from "../../lib/api";
import { PlatformIcon } from "../../components/PlatformIcon";
import { PostErrorDetail } from "../../components/PostErrorDetail";
import { Spinner } from "../../components/Spinner";
import { useDashboard } from "./DashboardContext";

const PAGE = 50;

// "YYYY-MM-DDTHH:mm" in the customer's own timezone, for <input type="datetime-local">.
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function FailedTab() {
  const { accounts, setPosts, setError } = useDashboard();
  const [failed, setFailed] = useState<ScheduledPost[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftWhen, setDraftWhen] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await api.listFailedPosts(undefined, PAGE);
      setFailed(rows);
      setHasMore(rows.length === PAGE);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFailed((prev) => prev ?? []);
    }
  }, [setError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keeps the Posts tab, the Overview tiles and the tab badge in step.
  async function syncDashboard() {
    try {
      setPosts(await api.listScheduledPosts());
    } catch {
      // The tab's own list is already correct; the dashboard catches up on its next refresh.
    }
  }

  async function loadMore() {
    const oldest = failed?.[failed.length - 1];
    if (!oldest?.scheduled_for) return;
    setLoadingMore(true);
    try {
      const more = await api.listFailedPosts(oldest.scheduled_for, PAGE);
      setFailed((prev) => [...(prev ?? []), ...more]);
      setHasMore(more.length === PAGE);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const all = failed ?? [];
    setSelected((prev) => (prev.size === all.length ? new Set() : new Set(all.map((x) => x.id))));
  }

  // One at a time on purpose: there is no bulk endpoint, and a burst of
  // parallel deletes would run into the per-account rate limit.
  async function removeSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const noun = ids.length === 1 ? "failed post" : "failed posts";
    if (!window.confirm(`Delete ${ids.length} ${noun}? This can't be undone.`)) return;
    setBulkBusy(true);
    setError(null);
    setMessage(null);
    const gone = new Set<string>();
    let lastError: string | null = null;
    for (const id of ids) {
      try {
        await api.deleteScheduledPost(id);
        gone.add(id);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    setFailed((prev) => (prev ?? []).filter((x) => !gone.has(x.id)));
    setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
    if (editingId && gone.has(editingId)) setEditingId(null);
    const failedCount = ids.length - gone.size;
    if (failedCount === 0) {
      setMessage(`Deleted ${gone.size} ${gone.size === 1 ? "post" : "posts"}.`);
    } else {
      setError(`Deleted ${gone.size}, but ${failedCount} could not be deleted${lastError ? `: ${lastError}` : "."}`);
    }
    await syncDashboard();
    setBulkBusy(false);
  }

  function startEdit(p: ScheduledPost) {
    setEditingId(p.id);
    setDraftText(p.content);
    setDraftWhen(localInputValue(new Date(Date.now() + 60 * 60 * 1000)));
    setMessage(null);
  }

  // Copy, (optionally) fix the text on the copy, then remove the failed original.
  async function repost(p: ScheduledPost, when: Date, newText?: string) {
    setBusyId(p.id);
    setError(null);
    setMessage(null);
    try {
      const copy = await api.duplicateScheduledPost(p.id, when.toISOString());
      if (newText !== undefined && newText !== p.content) {
        try {
          await api.updateDraft(copy.id, { content: newText });
        } catch (err) {
          // Never leave a copy that still has the old text queued to go out.
          await api.deleteScheduledPost(copy.id).catch(() => undefined);
          throw err;
        }
      }
      await api.deleteScheduledPost(p.id);
      setFailed((prev) => (prev ?? []).filter((x) => x.id !== p.id));
      setSelected((prev) => { const n = new Set(prev); n.delete(p.id); return n; });
      setEditingId(null);
      setMessage(when.getTime() <= Date.now() + 90 * 1000 ? "Done. It will go out within about a minute." : `Done. Scheduled for ${when.toLocaleString()}.`);
      await syncDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function postAgainNow(p: ScheduledPost) {
    if (!window.confirm("Post this again now? It will go out within about a minute.")) return;
    void repost(p, new Date(Date.now() + 60 * 1000));
  }

  function saveAndSchedule(p: ScheduledPost) {
    const when = new Date(draftWhen);
    if (Number.isNaN(when.getTime())) {
      setError("Pick a date and time first.");
      return;
    }
    if (!draftText.trim()) {
      setError("The post text can't be empty.");
      return;
    }
    // Never schedule in the past: the earliest is one minute from now.
    void repost(p, when.getTime() < Date.now() + 60 * 1000 ? new Date(Date.now() + 60 * 1000) : when, draftText);
  }

  async function remove(p: ScheduledPost) {
    if (!window.confirm("Delete this failed post? This can't be undone.")) return;
    setBusyId(p.id);
    setError(null);
    setMessage(null);
    try {
      await api.deleteScheduledPost(p.id);
      setFailed((prev) => (prev ?? []).filter((x) => x.id !== p.id));
      setSelected((prev) => { const n = new Set(prev); n.delete(p.id); return n; });
      if (editingId === p.id) setEditingId(null);
      await syncDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <h2>Failed posts</h2>
      <p className="section-note">
        These posts did not go out. Read why, fix the text if needed, then post again, pick a new time, or delete them.
      </p>
      {message && <p className="notice">{message}</p>}
      {failed === null && <Spinner />}
      {failed !== null && failed.length === 0 && <p className="empty">No failed posts. Everything went out.</p>}
      {failed !== null && failed.length > 0 && (
        <div className="failed-bulkbar">
          <label>
            <input
              type="checkbox"
              checked={selected.size === failed.length}
              onChange={toggleAll}
              disabled={bulkBusy}
              aria-label="Select all"
            />
            {hasMore ? `Select all ${failed.length} shown` : "Select all"}
          </label>
          {selected.size > 0 && (
            <button className="btn-outline" disabled={bulkBusy} onClick={() => void removeSelected()}>
              {bulkBusy ? "Deleting..." : `Delete selected (${selected.size})`}
            </button>
          )}
        </div>
      )}
      {failed !== null && failed.length > 0 && (
        <ul className="post-list">
          {failed.map((p) => {
            const result = p.post_results?.[0];
            const account = accounts.find((a) => a.id === p.social_account_id);
            const busy = busyId === p.id || bulkBusy;
            const editing = editingId === p.id;
            return (
              <li key={p.id} className="post-status-failed" data-testid="failed-post">
                <label className="failed-select">
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} disabled={bulkBusy} aria-label="Select this post" />
                  {account && (
                    <span className="post-platform">
                      <PlatformIcon platform={account.platform} size={14} />
                      {account.display_name ?? account.platform_account_id}
                    </span>
                  )}
                </label>
                {!editing && <div className="post-content">{p.content}</div>}
                <div className="post-meta">
                  <span className="status-badge status-failed">failed</span>
                  {p.scheduled_for && <span>{new Date(p.scheduled_for).toLocaleString()}</span>}
                  <PostErrorDetail errorMessage={result?.error_message ?? null} rawErrorMessage={result?.raw_error_message} platform={account?.platform} />
                </div>
                {editing && (
                  <div className="failed-edit">
                    <label>
                      Post text
                      <textarea value={draftText} onChange={(e) => setDraftText(e.target.value)} rows={5} />
                    </label>
                    <label>
                      Send at
                      <input type="datetime-local" value={draftWhen} onChange={(e) => setDraftWhen(e.target.value)} />
                    </label>
                    <div className="post-meta">
                      <button className="btn-primary" disabled={busy} onClick={() => saveAndSchedule(p)}>
                        {busy ? "..." : "Save and schedule"}
                      </button>
                      <button className="btn-outline" disabled={busy} onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {!editing && (
                  <div className="post-meta">
                    <button className="btn-outline" disabled={busy} onClick={() => startEdit(p)}>
                      Edit or reschedule
                    </button>
                    <button className="btn-outline" disabled={busy} onClick={() => postAgainNow(p)}>
                      {busy ? "..." : "Post again now"}
                    </button>
                    <button className="btn-outline" disabled={busy} onClick={() => void remove(p)}>
                      Delete
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <button className="btn-outline" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? "Loading..." : "Load more"}
        </button>
      )}
    </section>
  );
}
