import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../context/AuthContext";
import { api, type SocialAccount, type ScheduledPost } from "../lib/api";
import { RelaySignal } from "../components/RelaySignal";
import { BrandMark } from "../components/BrandMark";
import { PlatformIcon } from "../components/PlatformIcon";

export function Dashboard() {
  const { signOut } = useAuth();
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [content, setContent] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [selectedAccount, setSelectedAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function refresh() {
    setError(null);
    try {
      const [accs, pts] = await Promise.all([api.listSocialAccounts(), api.listScheduledPosts()]);
      setAccounts(accs);
      setPosts(pts);
      if (accs.length > 0 && !selectedAccount) setSelectedAccount(accs[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleConnect() {
    try {
      const { authorizeUrl } = await api.startConnect();
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSchedule(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.createScheduledPost({
        socialAccountId: selectedAccount,
        content,
        scheduledFor: new Date(scheduledFor).toISOString(),
      });
      setContent("");
      setScheduledFor("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteScheduledPost(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) return <p className="loading">Loading...</p>;

  return (
    <div className="dashboard">
      <header>
        <div className="wordmark">
          <BrandMark size={30} />
          <span>LazyRelay</span>
        </div>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>

      {error && <p className="error">{error}</p>}

      <section>
        <h2>Connected accounts</h2>
        {accounts.length === 0 ? (
          <p className="empty">No accounts connected yet — connect one to start scheduling posts.</p>
        ) : (
          <ul className="account-list">
            {accounts.map((a) => (
              <li key={a.id}>
                <span className="platform-badge">
                  <PlatformIcon platform={a.platform} size={13} />
                  {a.platform}
                </span>
                {a.display_name ?? a.platform_account_id}
              </li>
            ))}
          </ul>
        )}
        <button onClick={handleConnect}>+ Connect a social account</button>
      </section>

      <section>
        <h2>Schedule a post</h2>
        {accounts.length === 0 ? (
          <p className="empty">Connect an account first.</p>
        ) : (
          <form onSubmit={handleSchedule} className="schedule-form">
            <label>
              Account
              <select value={selectedAccount} onChange={(e) => setSelectedAccount(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name ?? a.platform_account_id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Content
              <textarea value={content} onChange={(e) => setContent(e.target.value)} required />
            </label>
            <label>
              When
              <input
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
                required
              />
            </label>
            <button type="submit" disabled={submitting}>
              {submitting ? "Scheduling..." : "Schedule"}
            </button>
          </form>
        )}
      </section>

      <section>
        <h2>Scheduled posts</h2>
        {posts.length === 0 ? (
          <p className="empty">Nothing scheduled yet.</p>
        ) : (
          <ul className="post-list">
            {posts.map((p) => {
              const result = p.post_results?.[0];
              return (
                <li key={p.id} className={`post-status-${p.status}`}>
                  <div className="post-content">{p.content}</div>
                  <div className="post-meta">
                    <span className={`status-badge status-${p.status}`}>{p.status}</span>
                    <span>{new Date(p.scheduled_for).toLocaleString()}</span>
                    {result && (
                      <span className={result.verified_live ? "verified" : "not-verified"}>
                        {result.verified_live ? (
                          <>
                            <RelaySignal size={14} pulsing /> Confirmed live
                          </>
                        ) : (
                          `Not confirmed — ${result.error_message ?? "couldn't verify"}`
                        )}
                      </span>
                    )}
                    {p.status === "pending" && <button onClick={() => handleDelete(p.id)}>Cancel</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
