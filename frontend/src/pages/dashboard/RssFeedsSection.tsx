import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { describeFeedStatus, type RssFeedList } from "../../lib/rssFeeds";

// Settings > RSS feeds: new items in a feed become drafts you can edit and
// schedule. Nothing is ever posted automatically. Self-contained.

interface Props {
  onError: (message: string | null) => void;
}

export function RssFeedsSection({ onError }: Props) {
  const [list, setList] = useState<RssFeedList | null>(null);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.listRssFeeds());
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await action();
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    await run(async () => {
      await api.createRssFeed({ url: url.trim(), ...(label.trim() ? { label: label.trim() } : {}) });
      setUrl("");
      setLabel("");
    });
  }

  const atLimit = !!list && list.feeds.length >= list.maxFeeds;

  return (
    <section>
      <h2>RSS feeds</h2>
      <p className="section-note">
        Add a blog or news feed and each new item becomes a draft with its title and link. Look in your drafts, edit the text,
        pick where it goes and schedule it. Nothing is posted automatically. Feeds are checked every 30 minutes, and posts
        already in the feed when you add it are skipped.
      </p>

      {list && list.feeds.length === 0 && <p className="empty">No feeds yet.</p>}
      {list?.feeds.map((f) => (
        <div key={f.id} style={{ marginBottom: 10 }}>
          <strong>{f.label || f.url}</strong>
          <div style={{ opacity: 0.8, fontSize: 14, wordBreak: "break-all" }}>{f.url}</div>
          <div style={{ fontSize: 14 }}>{describeFeedStatus(f)}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button type="button" className="btn-outline" disabled={busy} onClick={() => run(() => api.setRssFeedEnabled(f.id, !f.enabled))}>
              {f.enabled ? "Pause" : "Resume"}
            </button>
            <button type="button" className="btn-outline" disabled={busy} onClick={() => run(() => api.deleteRssFeed(f.id))}>
              Delete
            </button>
          </div>
        </div>
      ))}

      <form onSubmit={handleAdd} style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
        <input type="url" placeholder="https://example.com/feed.xml" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <input type="text" placeholder="Name (optional)" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit" className="btn-primary" disabled={busy || atLimit}>
          {atLimit ? "Feed limit reached" : busy ? "Checking the feed..." : "Add feed"}
        </button>
      </form>
    </section>
  );
}
