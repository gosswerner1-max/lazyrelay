import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import type { SnippetList } from "../../lib/snippets";

// Settings > Saved snippets: reusable text (a hashtag group, a call to action, a
// signature) that can be dropped into any post from the composer. Self-contained.

interface Props {
  onError: (message: string | null) => void;
}

export function SnippetsSection({ onError }: Props) {
  const [list, setList] = useState<SnippetList | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [isSignature, setIsSignature] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.listSnippets());
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
    if (!name.trim() || !content.trim()) return;
    await run(async () => {
      await api.createSnippet({ name: name.trim(), content: content.trim(), isSignature });
      setName("");
      setContent("");
      setIsSignature(false);
    });
  }

  const atLimit = !!list && list.snippets.length >= list.maxSnippets;

  return (
    <section>
      <h2>Saved snippets</h2>
      <p className="section-note">
        Save text you use again and again, like a hashtag group, a call to action or a sign-off. When you write a post, pick
        a snippet and it is added to the post box, where you can still change it. Mark one as your signature to get an
        "Add signature" button.
      </p>

      {list && list.snippets.length === 0 && <p className="empty">No snippets yet.</p>}
      {list?.snippets.map((s) => (
        <div key={s.id} className="webhook-row" style={{ marginBottom: 10 }}>
          <div>
            <strong>{s.name}</strong> {s.isSignature && <span className="coming-soon-badge">Signature</span>}
            <div style={{ whiteSpace: "pre-wrap", opacity: 0.8, fontSize: 14 }}>{s.content}</div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="btn-outline"
              disabled={busy}
              onClick={() => run(() => api.updateSnippet(s.id, { isSignature: !s.isSignature }))}
            >
              {s.isSignature ? "Not my signature" : "Make my signature"}
            </button>
            <button type="button" className="btn-outline" disabled={busy} onClick={() => run(() => api.deleteSnippet(s.id))}>
              Delete
            </button>
          </div>
        </div>
      ))}

      <form onSubmit={handleAdd} style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
        <input type="text" placeholder="Name (e.g. Sale hashtags)" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} required />
        <textarea placeholder="The text to insert" maxLength={2000} value={content} onChange={(e) => setContent(e.target.value)} required />
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={isSignature} onChange={(e) => setIsSignature(e.target.checked)} />
          Use as my signature
        </label>
        <button type="submit" className="btn-primary" disabled={busy || atLimit}>
          {atLimit ? "Snippet limit reached" : "Save snippet"}
        </button>
      </form>
    </section>
  );
}
